import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkDir } from "@co-motion/core";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `slide add` / `slide delete` / `slide duplicate` / `slide move` (#85),
 * driven purely through the CLI's own command registry against a real temp
 * presentation, with content read back off disk via `cat` — the seam this
 * unit's dispatch names, harness header copied verbatim from
 * `element-delete.test.ts`.
 */

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
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

async function openFreshPresentation(): Promise<{ id: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "投影片操作測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

async function readSlide(id: string, slidePath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  return result.data!.content;
}

async function catFails(id: string, slidePath: string): Promise<boolean> {
  const result = await registry.dispatch("cat", { id, path: slidePath });
  return result.ok === false;
}

/** Overwrites a slide directly on disk — test setup only, same technique as `element-delete.test.ts`. */
async function seedSlide(id: string, slidePath: string, content: string): Promise<void> {
  const workDir = await resolveWorkDir(id);
  await writeFile(path.join(workDir, slidePath), content, "utf-8");
}

/** Reads the last (most recent) undo group's virtual paths straight off `stack.json` (AC4c). */
async function lastUndoGroupPaths(id: string): Promise<string[]> {
  const stackFile = path.join(coMotionHome, "history", id, "stack.json");
  const raw = await readFile(stackFile, "utf-8");
  const parsed = JSON.parse(raw) as { undo: { entries: { virtualPath: string }[] }[] };
  const lastGroup = parsed.undo[parsed.undo.length - 1];
  return lastGroup.entries.map((entry) => entry.virtualPath);
}

async function undoGroupCount(id: string): Promise<number> {
  const stackFile = path.join(coMotionHome, "history", id, "stack.json");
  const raw = await readFile(stackFile, "utf-8");
  const parsed = JSON.parse(raw) as { undo: unknown[] };
  return parsed.undo.length;
}

describe("slide add (#85, AC1/AC5)", () => {
  it("adds one entry to project.json, creates the blank file, and one undo fully reverts it", async () => {
    const { id } = await openFreshPresentation();
    const beforeProjectJson = await readSlide(id, "project.json");

    const added = await registry.dispatch<{ slidePath: string; index: number }>("slide add", { id });
    expect(added.ok).toBe(true);
    expect(added.data).toEqual({ slidePath: "slides/002.svg", index: 2 });

    const afterProjectJson = await readSlide(id, "project.json");
    expect(JSON.parse(afterProjectJson).slides).toEqual(["slides/001.svg", "slides/002.svg"]);
    expect(await readSlide(id, "slides/002.svg")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n</svg>\n',
    );

    const undo = await registry.dispatch("undo", { id });
    expect(undo.ok).toBe(true);
    expect(await readSlide(id, "project.json")).toBe(beforeProjectJson);
    expect(await catFails(id, "slides/002.svg")).toBe(true);
  });

  it("with no --at, appends after the last slide", async () => {
    const { id } = await openFreshPresentation();
    await registry.dispatch("slide add", { id });
    const second = await registry.dispatch<{ slidePath: string; index: number }>("slide add", { id });
    expect(second.data).toEqual({ slidePath: "slides/003.svg", index: 3 });
  });

  it("--at inserts at the requested 1-based position", async () => {
    const { id } = await openFreshPresentation();
    const inserted = await registry.dispatch<{ slidePath: string; index: number }>("slide add", { id, at: 1 });
    expect(inserted.data).toEqual({ slidePath: "slides/002.svg", index: 1 });
    const project = JSON.parse(await readSlide(id, "project.json"));
    expect(project.slides).toEqual(["slides/002.svg", "slides/001.svg"]);
  });

  it("--at out of range throws naming the legal range, and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const before = await readSlide(id, "project.json");
    const result = await registry.dispatch("slide add", { id, at: 5 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("--at");
    expect(await readSlide(id, "project.json")).toBe(before);
  });

  it("undo of an add, then add again, reallocates the same filename (the orphan is already gone)", async () => {
    const { id } = await openFreshPresentation();
    const first = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(first.data!.slidePath).toBe("slides/002.svg");
    await registry.dispatch("undo", { id });

    const second = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    expect(second.data!.slidePath).toBe("slides/002.svg");
  });
});

describe("slide delete (#85, AC1/AC5)", () => {
  it("removes the slide's project.json entry and file; one undo restores both byte for byte", async () => {
    const { id } = await openFreshPresentation();
    await registry.dispatch("slide add", { id }); // now two slides, so deleting one is legal
    const beforeProjectJson = await readSlide(id, "project.json");
    const beforeSlideBytes = await readSlide(id, "slides/001.svg");

    const deleted = await registry.dispatch<{ slidePath: string; remaining: number }>("slide delete", {
      id,
      slidePath: "slides/001.svg",
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.data).toEqual({ slidePath: "slides/001.svg", remaining: 1 });
    expect(await catFails(id, "slides/001.svg")).toBe(true);

    const undo = await registry.dispatch("undo", { id });
    expect(undo.ok).toBe(true);
    expect(await readSlide(id, "slides/001.svg")).toBe(beforeSlideBytes);
    expect(await readSlide(id, "project.json")).toBe(beforeProjectJson);
  });

  it("refuses to delete the deck's only remaining slide, and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const before = await readSlide(id, "project.json");
    const result = await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("簡報至少要有一張投影片，無法刪除");
    expect(await readSlide(id, "project.json")).toBe(before);
  });

  it("a path not listed in slides throws 不是投影片, and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const before = await readSlide(id, "project.json");
    const result = await registry.dispatch("slide delete", { id, slidePath: "slides/999.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("不是投影片：slides/999.svg");
    expect(await readSlide(id, "project.json")).toBe(before);
  });

  it(
    "round-1 gate finding (W3-R11): when the undo-history commit fails after both files " +
      "already changed on disk, the deleted slide is restored and project.json is unchanged",
    async () => {
      const { id } = await openFreshPresentation();
      await registry.dispatch("slide add", { id }); // now two slides, so deleting one is legal
      const beforeProjectJson = await readSlide(id, "project.json");
      const beforeSlideBytes = await readSlide(id, "slides/001.svg");

      // Force stageSnapshotEntries' history dir to exist (it does, from the
      // `slide add` above), then make it unwritable so `commitSnapshotEntries`
      // -> `writeStack` fails exactly the way the gate reproduced it.
      const historyDir = path.join(coMotionHome, "history", id);
      await chmod(historyDir, 0o500);
      try {
        const result = await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
        expect(result.ok).toBe(false);
        expect(result.message).toBe("寫入復原歷史失敗，變更已還原");
      } finally {
        await chmod(historyDir, 0o700);
      }

      // The finding: the slide must still be on disk and project.json must
      // be byte-identical, not "reported failure but deleted the page anyway".
      expect(await readSlide(id, "slides/001.svg")).toBe(beforeSlideBytes);
      expect(await readSlide(id, "project.json")).toBe(beforeProjectJson);
    },
  );
});

describe("slide duplicate (#85, AC3/AC5)", () => {
  it("carries a <comot:effects> fixture verbatim, and lands immediately after the source", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    // Fixture shape copied from element-delete.test.ts (itself copied from demo/slides/003.svg).
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <comot:effects xmlns:comot="https://co-motion.dev/ns">
      <comot:effect target="el-step-one" family="enter" effect="appear" start="on-click"/>
    </comot:effects>
  </metadata>
  <g id="el-step-one"><rect width="1" height="1"/></g>
</svg>
`,
    );

    const result = await registry.dispatch<{ slidePath: string; index: number }>("slide duplicate", {
      id,
      slidePath,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ slidePath: "slides/002.svg", index: 2 });
    expect(await readSlide(id, "slides/002.svg")).toBe(await readSlide(id, slidePath));

    const project = JSON.parse(await readSlide(id, "project.json"));
    expect(project.slides).toEqual(["slides/001.svg", "slides/002.svg"]);
  });

  it("duplicating a fresh deck's non-compliant bare <text> slide succeeds — duplication never parses", async () => {
    const { id } = await openFreshPresentation();
    const result = await registry.dispatch("slide duplicate", { id, slidePath: "slides/001.svg" });
    expect(result.ok).toBe(true);
  });

  it("one undo removes the duplicate and restores project.json byte for byte", async () => {
    const { id } = await openFreshPresentation();
    const beforeProjectJson = await readSlide(id, "project.json");

    await registry.dispatch("slide duplicate", { id, slidePath: "slides/001.svg" });
    const undo = await registry.dispatch("undo", { id });
    expect(undo.ok).toBe(true);
    expect(await readSlide(id, "project.json")).toBe(beforeProjectJson);
    expect(await catFails(id, "slides/002.svg")).toBe(true);
  });

  it("a path not listed in slides throws 不是投影片, and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const before = await readSlide(id, "project.json");
    const result = await registry.dispatch("slide duplicate", { id, slidePath: "slides/999.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("不是投影片：slides/999.svg");
    expect(await readSlide(id, "project.json")).toBe(before);
  });
});

describe("slide move (#85, AC2/AC4/AC5)", () => {
  it("AC4: reordering never opens a slide file — mtimeNs and ino unchanged, content unchanged, undo group names exactly project.json", async () => {
    const { id } = await openFreshPresentation();
    await registry.dispatch("slide add", { id }); // slides/002.svg
    await registry.dispatch("slide add", { id }); // slides/003.svg
    const paths = ["slides/001.svg", "slides/002.svg", "slides/003.svg"];

    const workDir = await resolveWorkDir(id);
    const before = await Promise.all(paths.map((p) => stat(path.join(workDir, p), { bigint: true })));
    const contentBefore = await Promise.all(paths.map((p) => readSlide(id, p)));

    const moved = await registry.dispatch<{ from: number; to: number; changed: boolean }>("slide move", {
      id,
      slidePath: paths[2],
      to: 1,
    });
    expect(moved.ok).toBe(true);
    expect(moved.data).toEqual({ slidePath: paths[2], from: 3, to: 1, changed: true });

    const after = await Promise.all(paths.map((p) => stat(path.join(workDir, p), { bigint: true })));
    const contentAfter = await Promise.all(paths.map((p) => readSlide(id, p)));

    for (let i = 0; i < paths.length; i++) {
      expect(after[i].mtimeNs).toBe(before[i].mtimeNs);
      expect(after[i].ino).toBe(before[i].ino);
      expect(contentAfter[i]).toBe(contentBefore[i]);
    }

    expect(await lastUndoGroupPaths(id)).toEqual(["project.json"]);

    const project = JSON.parse(await readSlide(id, "project.json"));
    expect(project.slides).toEqual(["slides/003.svg", "slides/001.svg", "slides/002.svg"]);
  });

  it("--to equal to the current position succeeds, writes nothing, changed:false, and pushes no undo group", async () => {
    const { id } = await openFreshPresentation();
    await registry.dispatch("slide add", { id }); // slides/002.svg, 2 slides now
    const beforeProjectJson = await readSlide(id, "project.json");
    const groupsBefore = await undoGroupCount(id);

    const result = await registry.dispatch<{ from: number; to: number; changed: boolean }>("slide move", {
      id,
      slidePath: "slides/002.svg",
      to: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ slidePath: "slides/002.svg", from: 2, to: 2, changed: false });
    expect(result.message).toBe("順序未變");
    expect(await readSlide(id, "project.json")).toBe(beforeProjectJson);
    expect(await undoGroupCount(id)).toBe(groupsBefore);
  });

  it("--to out of range throws naming the legal range, and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const before = await readSlide(id, "project.json");
    const result = await registry.dispatch("slide move", { id, slidePath: "slides/001.svg", to: 2 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("--to");
    expect(await readSlide(id, "project.json")).toBe(before);
  });

  it("a path not listed in slides throws 不是投影片, and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const before = await readSlide(id, "project.json");
    const result = await registry.dispatch("slide move", { id, slidePath: "slides/999.svg", to: 1 });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("不是投影片：slides/999.svg");
    expect(await readSlide(id, "project.json")).toBe(before);
  });

  it("one undo restores the pre-move order byte for byte", async () => {
    const { id } = await openFreshPresentation();
    await registry.dispatch("slide add", { id });
    const beforeMove = await readSlide(id, "project.json");

    await registry.dispatch("slide move", { id, slidePath: "slides/002.svg", to: 1 });
    const undo = await registry.dispatch("undo", { id });
    expect(undo.ok).toBe(true);
    expect(await readSlide(id, "project.json")).toBe(beforeMove);
  });
});
