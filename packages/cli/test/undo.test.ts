import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePresentationFile } from "@co-motion/core";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";
import type { CommandHandler } from "../src/registry.js";

// Same per-test isolation as text-set.test.ts (ADR-0004, ticket #9
// testing convention): every test gets its own CO_MOTION_HOME, so history
// storage under it is isolated too.
let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Opens a freshly created presentation and returns its id and title element id. */
async function openFreshPresentation(): Promise<{ id: string; elementId: string; originalSlide: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const slide = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  const originalSlide = slide.data!.content;
  const match = /<text id="(el-[^"]+)"/.exec(originalSlide);
  if (!match) throw new Error("test fixture: title element id not found");
  return { id, elementId: match[1], originalSlide };
}

describe("undo / redo — a single text set", () => {
  it("undo restores the original text; redo brings the new text back", async () => {
    const { id, elementId, originalSlide } = await openFreshPresentation();

    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "新標題" });

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    expect(undone.message).toBe("已復原上一步操作");
    const afterUndo = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(afterUndo.data!.content).toBe(originalSlide);

    const redone = await registry.dispatch("redo", { id });
    expect(redone.ok).toBe(true);
    expect(redone.message).toBe("已重做上一步操作");
    const afterRedo = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(afterRedo.data!.content).toContain(">新標題</text>");
  });

  it("fails with a clear error when the undo stack is empty", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("undo", { id });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("沒有可復原的操作");
  });

  it("fails with a clear error when the redo stack is empty", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("redo", { id });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("沒有可重做的操作");
  });

  it("a new edit after an undo clears the redo stack", async () => {
    const { id, elementId } = await openFreshPresentation();

    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第一版" });
    await registry.dispatch("undo", { id });
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第二版" });

    const result = await registry.dispatch("redo", { id });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("沒有可重做的操作");
  });

  it("a failed text set (unknown element) occupies no undo step", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId: "el-does-not-exist",
      newText: "x",
    });
    expect(result.ok).toBe(false);

    const undo = await registry.dispatch("undo", { id });
    expect(undo.ok).toBe(false);
    expect(undo.message).toBe("沒有可復原的操作");
  });

  it("never leaks the real work directory path in undo/redo messages", async () => {
    const { id, elementId } = await openFreshPresentation();
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "新標題" });

    const undone = await registry.dispatch("undo", { id });
    expect(undone.message).not.toContain(coMotionHome);
    const empty = await registry.dispatch("undo", { id });
    expect(empty.message).not.toContain(coMotionHome);

    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "再一次" });
    const redone = await registry.dispatch("redo", { id }); // redo stack was cleared by the edit above
    expect(redone.message).not.toContain(coMotionHome);
  });
});

describe("history group errors never leak the real work directory path", () => {
  it("beginHistoryGroup joining an already-open group returns false and does not open a second group (NOOP-67 r2, [Fix.4])", async () => {
    const { beginHistoryGroup, endHistoryGroup } = await import("@co-motion/core");
    const { id, elementId } = await openFreshPresentation();

    const opened = await beginHistoryGroup(id);
    expect(opened).toBe(true);
    const joined = await beginHistoryGroup(id);
    expect(joined).toBe(false);

    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "A" });
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "B" });
    // The joiner must NOT close the group — only the owner (the `true`
    // caller) may call endHistoryGroup. Closing once collects both writes
    // into a single undo step.
    await endHistoryGroup(id);

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    const second = await registry.dispatch("undo", { id });
    expect(second.ok).toBe(false);
    expect(second.message).toBe("沒有可復原的操作");
  });

  it("endHistoryGroup without a matching begin reports a clear error without the real path", async () => {
    const { endHistoryGroup } = await import("@co-motion/core");
    const { id } = await openFreshPresentation();

    await expect(endHistoryGroup(id)).rejects.toMatchObject({ message: "沒有開啟中的復原群組" });
    expect("沒有開啟中的復原群組").not.toContain(coMotionHome);
  });

  it("a corrupt stack.json reports damage without the real path", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { id, elementId } = await openFreshPresentation();
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "新標題" });

    const stackFile = path.join(coMotionHome, "history", id, "stack.json");
    await mkdir(path.dirname(stackFile), { recursive: true });
    await writeFile(stackFile, "{ not valid json", "utf-8");

    const result = await registry.dispatch("undo", { id });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("復原歷史已損毀");
    expect(result.message).not.toContain(coMotionHome);
  });
});

describe("undo — an agent turn groups multiple commands into one step (AC 2)", () => {
  it("beginHistoryGroup / endHistoryGroup: three text set calls on the same slide undo together", async () => {
    const { beginHistoryGroup, endHistoryGroup } = await import("@co-motion/core");
    const comotPath = path.join(comotDir, "deck.comot");
    await registry.dispatch("new", { path: comotPath, name: "群組測試" });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    // Add two more text elements so the same slide has three independently
    // editable ids to exercise "three commands, one virtual path, one group".
    const before = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    const withThreeTexts = before.data!.content.replace(
      "</svg>",
      '<text id="el-b" x="10" y="10">B</text><text id="el-c" x="20" y="20">C</text></svg>',
    );
    await writePresentationFile(id, "slides/001.svg", withThreeTexts);
    const original = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });

    const match = /<text id="(el-[^"]+)"/.exec(original.data!.content);
    if (!match) throw new Error("test fixture: title element id not found");
    const titleId = match[1];

    await beginHistoryGroup(id);
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId: titleId, newText: "A2" });
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId: "el-b", newText: "B2" });
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId: "el-c", newText: "C2" });
    await endHistoryGroup(id);

    const changed = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(changed.data!.content).toContain(">A2<");
    expect(changed.data!.content).toContain(">B2<");
    expect(changed.data!.content).toContain(">C2<");

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    const restored = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    // The grouped undo brings the slide back to what it was right before
    // the group started — one step, even though three commands ran inside
    // it — not to `before` (that earlier writePresentationFile call, done
    // outside the group, is its own separate undo step).
    expect(restored.data!.content).toBe(original.data!.content);

    // The setup's writePresentationFile call is still its own undo step
    // underneath the group's, so this second undo succeeds too, restoring
    // the presentation to what it was before that call.
    const second = await registry.dispatch("undo", { id });
    expect(second.ok).toBe(true);
    const restoredToBefore = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(restoredToBefore.data!.content).toBe(before.data!.content);

    const third = await registry.dispatch("undo", { id });
    expect(third.ok).toBe(false);
    expect(third.message).toBe("沒有可復原的操作");
  });
});

describe("undo — multi-file commands inside an agent-turn group don't throw (NOOP-67 r2)", () => {
  it("[Fix.1] slide add + slide duplicate under an open turn group both succeed, and one undo收回整個 turn", async () => {
    const { beginHistoryGroup, endHistoryGroup } = await import("@co-motion/core");
    const id = await openFreshPresentation().then((r) => r.id);
    const readSlides = async () => {
      const project = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
      return (JSON.parse(project.data!.content).slides as string[]).length;
    };
    const before = await readSlides();

    await beginHistoryGroup(id);
    const added = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(added.ok).toBe(true);
    const duplicated = await registry.dispatch<{ slidePath: string }>("slide duplicate", {
      id,
      slidePath: added.data!.slidePath,
    });
    expect(duplicated.ok).toBe(true);
    await endHistoryGroup(id);

    expect(await readSlides()).toBe(before + 2);

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    expect(await readSlides()).toBe(before);
    const second = await registry.dispatch("undo", { id });
    expect(second.ok).toBe(false);
    expect(second.message).toBe("沒有可復原的操作");
  });

  it("[Fix.2] all five multi-file commands succeed under an open turn group (slide add/delete/duplicate, template add/delete)", async () => {
    const { beginHistoryGroup, endHistoryGroup } = await import("@co-motion/core");
    const id = await openFreshPresentation().then((r) => r.id);

    await beginHistoryGroup(id);
    const add1 = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(add1.ok).toBe(true);
    const add2 = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(add2.ok).toBe(true);
    const duplicated = await registry.dispatch<{ slidePath: string }>("slide duplicate", {
      id,
      slidePath: add2.data!.slidePath,
    });
    expect(duplicated.ok).toBe(true);
    const deleted = await registry.dispatch("slide delete", { id, slidePath: add1.data!.slidePath });
    expect(deleted.ok).toBe(true);
    const templateAdded = await registry.dispatch<{ templatePath: string }>("template add", { id });
    expect(templateAdded.ok).toBe(true);
    const templateDeleted = await registry.dispatch("template delete", { id, templatePath: templateAdded.data!.templatePath });
    expect(templateDeleted.ok).toBe(true);
    await endHistoryGroup(id);
  });

  it("[Fix.3] standalone execution (no open turn group) keeps its own undo granularity — one command, one step", async () => {
    const id = await openFreshPresentation().then((r) => r.id);

    await registry.dispatch("slide add", { id });
    await registry.dispatch("slide add", { id });

    const first = await registry.dispatch("undo", { id });
    expect(first.ok).toBe(true);
    const project = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
    expect(JSON.parse(project.data!.content).slides.length).toBe(2); // original 1 + the first add

    const second = await registry.dispatch("undo", { id });
    expect(second.ok).toBe(true);
    const third = await registry.dispatch("undo", { id });
    expect(third.ok).toBe(false);
    expect(third.message).toBe("沒有可復原的操作");
  });
});

describe("writePresentationFile — the single write door (AC 4)", () => {
  it("a brand-new command with zero inverse logic gets undo for free by writing through writePresentationFile", async () => {
    const { id, originalSlide } = await openFreshPresentation();

    // A throwaway command, registered only in this test, whose entire body
    // is one call to writePresentationFile — no hand-written inverse.
    interface WhateverInput {
      id: string;
      content: string;
    }
    const whateverCommand: CommandHandler<WhateverInput, Record<string, never>> = async (input) => {
      await writePresentationFile(input.id, "slides/001.svg", input.content);
      return { ok: true, data: {}, message: "done" };
    };
    const testRegistry = new (registry.constructor as new () => CommandRegistry)();
    testRegistry.register("whatever", { handler: whateverCommand, render: null });

    const result = await testRegistry.dispatch("whatever", { id, content: "<svg>whatever</svg>" });
    expect(result.ok).toBe(true);

    const { undoLastGroup } = await import("@co-motion/core");
    const { restoredPaths } = await undoLastGroup(id);
    expect(restoredPaths).toEqual(["slides/001.svg"]);

    const after = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(after.data!.content).toBe(originalSlide);
  });
});

describe("history storage never enters the packed .comot (AC 3)", () => {
  it("pack's output contains no history/stack.json/snapshots entry", async () => {
    const { id, elementId } = await openFreshPresentation();
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "新標題" });

    const outputPath = path.join(comotDir, "out.comot");
    const packed = await registry.dispatch("pack", { id, path: outputPath });
    expect(packed.ok).toBe(true);

    const { unzipSync } = await import("fflate");
    const bytes = await readFile(outputPath);
    const entries = Object.keys(unzipSync(bytes));
    for (const entry of entries) {
      expect(entry).not.toContain("history");
      expect(entry).not.toContain("stack.json");
      expect(entry).not.toContain("snapshots");
    }
  });

  it("reopening the same .comot starts with an empty undo history", async () => {
    const { id, elementId } = await openFreshPresentation();
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "新標題" });

    const outputPath = path.join(comotDir, "out.comot");
    await registry.dispatch("pack", { id, path: outputPath });
    const reopened = await registry.dispatch<{ id: string }>("open", { path: outputPath });

    const result = await registry.dispatch("undo", { id: reopened.data!.id });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("沒有可復原的操作");
  });
});

describe("undo stack cap (指揮官裁決 5): 50 groups, oldest evicted with its snapshot deleted", () => {
  it("pushing 51 groups keeps only the newest 50, and the evicted group's snapshot file is deleted from disk", async () => {
    const { id, elementId, originalSlide } = await openFreshPresentation();

    // Edit i's undo-group snapshot holds the content from right before that
    // edit, so group 0's snapshot is `originalSlide` and group 1's is the
    // content after edit 0 (containing "第0版"), and so on.
    for (let i = 0; i < 51; i++) {
      await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: `第${i}版` });
    }

    // 51 edits push 51 undo groups; the cap evicts the oldest one (group 0,
    // whose snapshot is `originalSlide`) and deletes its snapshot file.
    const historyDir = path.join(coMotionHome, "history", id);
    const snapshotsDir = path.join(historyDir, "snapshots");
    const { readdir } = await import("node:fs/promises");
    const snapshotFiles = await readdir(snapshotsDir);
    expect(snapshotFiles.length).toBe(50);

    // Undoing 50 times unwinds edits 50 down to 1, landing on the content
    // right after edit 0 ("第0版") — never back to `originalSlide`, because
    // the group that would restore it (group 0) was evicted.
    for (let i = 0; i < 50; i++) {
      const result = await registry.dispatch("undo", { id });
      expect(result.ok).toBe(true);
    }
    const noMore = await registry.dispatch("undo", { id });
    expect(noMore.ok).toBe(false);
    expect(noMore.message).toBe("沒有可復原的操作");

    const final = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
    expect(final.data!.content).toContain(">第0版<");
    expect(final.data!.content).not.toBe(originalSlide);
  });
});

describe("finding 3 (critical) — a raw filesystem I/O error never escapes undo (ADR-0004)", () => {
  it("a permission-denied snapshots directory reports a CoMotionError, never a raw EACCES with a real path", async () => {
    // chmod cannot deny root a write, so this reproduction is meaningless
    // (and would leave an unremovable temp dir) when run as root.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const { id, elementId } = await openFreshPresentation();
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第一版" });

    const snapshotsDir = path.join(coMotionHome, "history", id, "snapshots");
    const { chmod } = await import("node:fs/promises");
    await chmod(snapshotsDir, 0o555); // read + execute, no write — undo's inverse-snapshot write must fail
    try {
      const result = await registry.dispatch("undo", { id });
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(coMotionHome);
      expect(result.message).not.toContain("EACCES");
    } finally {
      // Restore permissions before afterEach's rm, or the temp dir cannot be removed.
      await chmod(snapshotsDir, 0o755);
    }
  });
});

describe("finding 1 (high) — clearing the redo stack deletes its snapshot files, no orphans", () => {
  it("text set → undo → text set leaves no snapshot file on disk unreferenced by any stack", async () => {
    const { id, elementId } = await openFreshPresentation();

    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第一版" });
    await registry.dispatch("undo", { id }); // pushes an inverse snapshot onto the redo stack
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第二版" }); // must clear + delete that redo snapshot

    const historyDir = path.join(coMotionHome, "history", id);
    const { readFile: readFileFs, readdir } = await import("node:fs/promises");
    const stack = JSON.parse(await readFileFs(path.join(historyDir, "stack.json"), "utf-8")) as {
      undo: { entries: { snapshotId: string }[] }[];
      redo: { entries: { snapshotId: string }[] }[];
      openGroup: { entries: { snapshotId: string }[] } | null;
    };
    const referenced = new Set<string>();
    for (const group of [...stack.undo, ...stack.redo, ...(stack.openGroup ? [stack.openGroup] : [])]) {
      for (const entry of group.entries) referenced.add(entry.snapshotId);
    }

    const onDisk = await readdir(path.join(historyDir, "snapshots"));
    expect(new Set(onDisk)).toEqual(referenced);
  });
});

describe("gate round 2 finding — a failed stack write never dangles a snapshot reference", () => {
  it("history dir unwritable at commit time: old stack.json survives intact, every snapshot it references still exists", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const { id, elementId } = await openFreshPresentation();
    // Build a redo entry first, so the failing commit below has something
    // it would (wrongly, pre-fix) delete before the write it depends on.
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第一版" });
    await registry.dispatch("undo", { id });

    const historyDir = path.join(coMotionHome, "history", id);
    const { readFile: readFileFs, readdir, chmod } = await import("node:fs/promises");
    const stackPath = path.join(historyDir, "stack.json");
    const beforeStack = await readFileFs(stackPath, "utf-8");

    // Read + execute but no write on the history dir itself (snapshots/ is
    // untouched): stack.json can still be read, but writeStack's temp-file
    // write inside historyDir must fail.
    await chmod(historyDir, 0o555);
    try {
      const result = await registry.dispatch("text set", {
        id,
        slidePath: "slides/001.svg",
        elementId,
        newText: "第二版",
      });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("無法寫入復原歷史");
    } finally {
      await chmod(historyDir, 0o755);
    }

    // The old stack.json — the one from before the failed commit — must be
    // untouched, and every snapshot id it references must still be on disk.
    const afterStack = await readFileFs(stackPath, "utf-8");
    expect(afterStack).toBe(beforeStack);
    const parsed = JSON.parse(afterStack) as {
      undo: { entries: { snapshotId: string }[] }[];
      redo: { entries: { snapshotId: string }[] }[];
      openGroup: { entries: { snapshotId: string }[] } | null;
    };
    const referenced = new Set<string>();
    for (const group of [...parsed.undo, ...parsed.redo, ...(parsed.openGroup ? [parsed.openGroup] : [])]) {
      for (const entry of group.entries) referenced.add(entry.snapshotId);
    }
    expect(referenced.size).toBeGreaterThan(0);

    const onDisk = new Set(await readdir(path.join(historyDir, "snapshots")));
    for (const snapshotId of referenced) {
      expect(onDisk.has(snapshotId)).toBe(true);
    }
  });
});

describe("finding 2 (high) — a failed content write never consumes an undo slot", () => {
  it("a permission-denied slide file: text set fails, undo reports nothing to undo, and no orphan snapshot is left", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const { id, elementId } = await openFreshPresentation();
    const slidePath = path.join(coMotionHome, "work", id, "slides", "001.svg");
    const { chmod, readdir } = await import("node:fs/promises");
    await chmod(slidePath, 0o444); // read-only — the actual content write must fail
    try {
      const result = await registry.dispatch("text set", {
        id,
        slidePath: "slides/001.svg",
        elementId,
        newText: "失敗版",
      });
      expect(result.ok).toBe(false);
    } finally {
      await chmod(slidePath, 0o644);
    }

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(false);
    expect(undone.message).toBe("沒有可復原的操作");

    const snapshotsDir = path.join(coMotionHome, "history", id, "snapshots");
    let snapshotFiles: string[] = [];
    try {
      snapshotFiles = await readdir(snapshotsDir);
    } catch {
      snapshotFiles = []; // directory may not have been created at all — also fine
    }
    expect(snapshotFiles).toEqual([]);
  });
});

describe("gate round 3 finding — applyGroup defers deleting the snapshots it consumes", () => {
  it("history dir unwritable at undo time: old stack.json survives intact, every snapshot it references still exists, and a later undo still works", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const { id, elementId } = await openFreshPresentation();
    // Two groups on the undo stack, so a still-broken applyGroup (deleting
    // the consumed snapshot before the caller's writeStack) would strand
    // every undo below the top, not just the very first one.
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第一版" });
    await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText: "第二版" });

    const historyDir = path.join(coMotionHome, "history", id);
    const { readFile: readFileFs, readdir, chmod } = await import("node:fs/promises");
    const stackPath = path.join(historyDir, "stack.json");
    const beforeStack = await readFileFs(stackPath, "utf-8");

    // Read + execute but no write on the history dir itself — snapshots/
    // stays writable, so applyGroup's restore (write + old-style delete)
    // still succeeds, but the undo's own writeStack (a temp file directly
    // inside historyDir) must fail.
    await chmod(historyDir, 0o555);
    try {
      const result = await registry.dispatch("undo", { id });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("無法寫入復原歷史");
    } finally {
      await chmod(historyDir, 0o755);
    }

    // The old stack.json must be untouched, and every snapshot id it
    // references must still be on disk — no dangling reference.
    const afterStack = await readFileFs(stackPath, "utf-8");
    expect(afterStack).toBe(beforeStack);
    const parsed = JSON.parse(afterStack) as {
      undo: { entries: { snapshotId: string }[] }[];
      redo: { entries: { snapshotId: string }[] }[];
      openGroup: { entries: { snapshotId: string }[] } | null;
    };
    const referenced = new Set<string>();
    for (const group of [...parsed.undo, ...parsed.redo, ...(parsed.openGroup ? [parsed.openGroup] : [])]) {
      for (const entry of group.entries) referenced.add(entry.snapshotId);
    }
    expect(referenced.size).toBeGreaterThan(0);

    const onDisk = new Set(await readdir(path.join(historyDir, "snapshots")));
    for (const snapshotId of referenced) {
      expect(onDisk.has(snapshotId)).toBe(true);
    }

    // The actual user-visible harm: undo must still work afterwards, not
    // report a permanently corrupted history.
    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    expect(undone.message).toBe("已復原上一步操作");
  });
});
