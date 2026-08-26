import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkDir } from "@co-motion/core";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `element delete` (#74, AC2/AC3), driven purely through the CLI's own
 * command registry against a real temp presentation, with the SVG read back
 * off disk via `cat` — the seam this unit's dispatch names, following
 * `packages/cli/test/textbox.test.ts`'s pattern (per-test `CO_MOTION_HOME`).
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
  await registry.dispatch("new", { path: comotPath, name: "刪除測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

async function readSlide(id: string, slidePath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  return result.data!.content;
}

/** Overwrites slide 1 with `content` directly on disk — test setup only, same technique as `shape.test.ts`. */
async function seedSlide(id: string, slidePath: string, content: string): Promise<void> {
  const workDir = await resolveWorkDir(id);
  await writeFile(path.join(workDir, slidePath), content, "utf-8");
}

describe("element delete (#74)", () => {
  it("AC2: one element delete naming three ids removes all three, and one undo restores the slide byte for byte", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";

    const a = await registry.dispatch<{ elementId: string }>("rect add", { id, slidePath, x: 0, y: 0, width: 10, height: 10 });
    const b = await registry.dispatch<{ elementId: string }>("rect add", { id, slidePath, x: 20, y: 0, width: 10, height: 10 });
    const c = await registry.dispatch<{ elementId: string }>("rect add", { id, slidePath, x: 40, y: 0, width: 10, height: 10 });
    const beforeDelete = await readSlide(id, slidePath);

    const deleted = await registry.dispatch<{ deleted: string[]; clearedEffects: number }>("element delete", {
      id,
      slidePath,
      elementIds: [a.data!.elementId, b.data!.elementId, c.data!.elementId],
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.data!.deleted.sort()).toEqual([a.data!.elementId, b.data!.elementId, c.data!.elementId].sort());

    const afterDelete = await readSlide(id, slidePath);
    expect(afterDelete).not.toContain(a.data!.elementId);
    expect(afterDelete).not.toContain(b.data!.elementId);
    expect(afterDelete).not.toContain(c.data!.elementId);

    const undo = await registry.dispatch("undo", { id });
    expect(undo.ok).toBe(true);
    // Byte for byte: one delete of three elements is one undo step.
    expect(await readSlide(id, slidePath)).toBe(beforeDelete);
  });

  it("AC3: deleting an element clears exactly the effect entries targeting it", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    // Fixture shape copied from demo/slides/003.svg (read, not edited).
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <comot:effects xmlns:comot="https://co-motion.dev/ns">
      <comot:effect target="el-step-one" family="enter" effect="appear" start="on-click"/>
      <comot:effect target="el-step-two" family="enter" effect="fade" start="on-click"/>
      <comot:effect target="el-step-three" family="enter" effect="fade" start="on-click"/>
    </comot:effects>
  </metadata>
  <g id="el-step-one"><rect width="1" height="1"/></g>
  <g id="el-step-two"><rect width="1" height="1"/></g>
  <g id="el-step-three"><rect width="1" height="1"/></g>
</svg>
`,
    );

    const result = await registry.dispatch<{ deleted: string[]; clearedEffects: number }>("element delete", {
      id,
      slidePath,
      elementIds: ["el-step-one", "el-step-two"],
    });
    expect(result.ok).toBe(true);
    expect(result.data!.clearedEffects).toBe(2);

    const after = await readSlide(id, slidePath);
    const remainingEffects = after.match(/<comot:effect\b[^>]*>/g) ?? [];
    expect(remainingEffects).toHaveLength(1);
    expect(remainingEffects[0]).toContain('target="el-step-three"');
    expect(after).not.toContain('target="el-step-one"');
    expect(after).not.toContain('target="el-step-two"');
  });

  it("AC3: deleting a group clears effect entries targeting its descendants", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <comot:effects xmlns:comot="https://co-motion.dev/ns">
      <comot:effect target="el-inner" family="enter" effect="appear" start="on-click"/>
    </comot:effects>
  </metadata>
  <g id="el-outer"><g id="el-inner"><rect width="1" height="1"/></g></g>
  <g id="el-keep"><rect width="1" height="1"/></g>
</svg>
`,
    );

    const result = await registry.dispatch<{ deleted: string[]; clearedEffects: number }>("element delete", {
      id,
      slidePath,
      elementIds: ["el-outer"],
    });
    expect(result.ok).toBe(true);
    expect(result.data!.clearedEffects).toBe(1);
    expect(result.data!.deleted.sort()).toEqual(["el-inner", "el-outer"]);

    const after = await readSlide(id, slidePath);
    expect(after).not.toContain("<comot:effect ");
    expect(after).toContain("el-keep");
  });

  // W2-R12 regression: `packages/web/src/effects.ts` reads effect entries
  // with a DESCENDANT search (getElementsByTagNameNS), so an entry nested
  // one level under a wrapper element inside <comot:effects> is a real
  // entry to the player. Before this fix, `element delete` only looked at
  // direct children of <comot:effects> and left this entry — a dangling
  // reference to a deleted element — on disk (clearedEffects: 0).
  it("AC3: deleting an element clears an effect entry nested inside a wrapper under <comot:effects>", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <comot:effects xmlns:comot="https://co-motion.dev/ns">
      <comot:effect target="el-flat" family="enter" effect="fade" start="on-click"/>
      <comot:group>
        <comot:effect target="el-nested" family="enter" effect="fade" start="on-click"/>
      </comot:group>
    </comot:effects>
  </metadata>
  <g id="el-flat" transform="translate(0 0)"><rect width="10" height="10"/></g>
  <g id="el-nested" transform="translate(0 0)"><rect width="10" height="10"/></g>
</svg>
`,
    );

    const result = await registry.dispatch<{ deleted: string[]; clearedEffects: number }>("element delete", {
      id,
      slidePath,
      elementIds: ["el-nested"],
    });
    expect(result.ok).toBe(true);
    expect(result.data!.clearedEffects).toBe(1);

    const after = await readSlide(id, slidePath);
    expect(after).not.toContain('target="el-nested"');
    expect(after).toContain('target="el-flat"');
  });

  // W2-R14 regression: `effects.ts` matches by namespace URI
  // (getElementsByTagNameNS), which a default `xmlns="…"` binding satisfies
  // just as well as a prefixed `xmlns:comot="…"` one. Before this fix, core's
  // hand-rolled resolver only tracked `xmlns:PREFIX` bindings and required a
  // non-null prefix on the tag itself, so an effect list written with a
  // default namespace (no `comot:` prefix at all) was invisible to
  // `element delete` — leaving a dangling `target` reference on disk.
  it("AC3: deleting an element clears an effect entry written with a default (unprefixed) namespace", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <effects xmlns="https://co-motion.dev/ns">
      <effect target="el-flat" family="enter" effect="fade" start="on-click"/>
      <effect target="el-delete" family="enter" effect="fade" start="on-click"/>
    </effects>
  </metadata>
  <g id="el-flat" transform="translate(0 0)"><rect width="10" height="10"/></g>
  <g id="el-delete" transform="translate(0 0)"><rect width="10" height="10"/></g>
</svg>
`,
    );

    const result = await registry.dispatch<{ deleted: string[]; clearedEffects: number }>("element delete", {
      id,
      slidePath,
      elementIds: ["el-delete"],
    });
    expect(result.ok).toBe(true);
    expect(result.data!.clearedEffects).toBe(1);

    const after = await readSlide(id, slidePath);
    expect(after).not.toContain('target="el-delete"');
    expect(after).toContain('target="el-flat"');
  });

  // Same default-namespace binding as above, but the matching entry is
  // nested one level under a wrapper element — covers the intersection of
  // W2-R12 (descendant search) and W2-R14 (default namespace) in one list.
  it("AC3: deleting an element clears a default-namespace effect entry nested inside a wrapper", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <effects xmlns="https://co-motion.dev/ns">
      <effect target="el-flat" family="enter" effect="fade" start="on-click"/>
      <group>
        <effect target="el-nested" family="enter" effect="fade" start="on-click"/>
      </group>
    </effects>
  </metadata>
  <g id="el-flat" transform="translate(0 0)"><rect width="10" height="10"/></g>
  <g id="el-nested" transform="translate(0 0)"><rect width="10" height="10"/></g>
</svg>
`,
    );

    const result = await registry.dispatch<{ deleted: string[]; clearedEffects: number }>("element delete", {
      id,
      slidePath,
      elementIds: ["el-nested"],
    });
    expect(result.ok).toBe(true);
    expect(result.data!.clearedEffects).toBe(1);

    const after = await readSlide(id, slidePath);
    expect(after).not.toContain('target="el-nested"');
    expect(after).toContain('target="el-flat"');
  });

  // Negative case: an unprefixed <effects> with no xmlns of its own is in
  // the SVG namespace (inherited from <svg xmlns="…">), NOT the effects
  // namespace — it must NOT be treated as an effect list. A careless fix for
  // the default-namespace case (matching any unprefixed "effects" tag,
  // regardless of resolved namespace) breaks exactly this.
  it("AC3: an unprefixed <effects> with no xmlns of its own is NOT an effect list", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <effects>
      <effect target="el-delete" family="enter" effect="fade" start="on-click"/>
    </effects>
  </metadata>
  <g id="el-delete" transform="translate(0 0)"><rect width="10" height="10"/></g>
</svg>
`,
    );

    const result = await registry.dispatch<{ deleted: string[]; clearedEffects: number }>("element delete", {
      id,
      slidePath,
      elementIds: ["el-delete"],
    });
    expect(result.ok).toBe(true);
    // Not an effects namespace list, so nothing is cleared — but the
    // element itself is still removed. The stray SVG-namespace <effect>
    // markup is left untouched (harmless: the player never reads it, since
    // it too resolves to the SVG namespace, not the effects one).
    expect(result.data!.clearedEffects).toBe(0);

    const after = await readSlide(id, slidePath);
    expect(after).toContain('target="el-delete"');
  });

  it("an unknown element id leaves the file byte-identical", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    const added = await registry.dispatch<{ elementId: string }>("rect add", { id, slidePath, x: 0, y: 0, width: 10, height: 10 });
    const before = await readSlide(id, slidePath);

    const result = await registry.dispatch("element delete", {
      id,
      slidePath,
      elementIds: [added.data!.elementId, "el-does-not-exist"],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("el-does-not-exist");
    expect(await readSlide(id, slidePath)).toBe(before);
  });

  it("deleting every child of a group throws naming the parent, and writes nothing", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <g id="el-group"><g id="el-only-child"><rect width="1" height="1"/></g></g>
</svg>
`,
    );
    const before = await readSlide(id, slidePath);

    const result = await registry.dispatch("element delete", { id, slidePath, elementIds: ["el-only-child"] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("el-group");
    expect(await readSlide(id, slidePath)).toBe(before);
  });

  it("refuses a bare primitive on an unconverted slide, telling the author to run convert first", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    await seedSlide(
      id,
      slidePath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <rect id="el-bare" width="1" height="1"/>
</svg>
`,
    );
    const before = await readSlide(id, slidePath);

    const result = await registry.dispatch("element delete", { id, slidePath, elementIds: ["el-bare"] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("convert");
    expect(await readSlide(id, slidePath)).toBe(before);
  });

  it("the same id listed twice collapses to one removal, no error", async () => {
    const { id } = await openFreshPresentation();
    const slidePath = "slides/001.svg";
    const added = await registry.dispatch<{ elementId: string }>("rect add", { id, slidePath, x: 0, y: 0, width: 10, height: 10 });

    const result = await registry.dispatch<{ deleted: string[] }>("element delete", {
      id,
      slidePath,
      elementIds: [added.data!.elementId, added.data!.elementId],
    });
    expect(result.ok).toBe(true);
    expect(result.data!.deleted).toEqual([added.data!.elementId]);
  });
});
