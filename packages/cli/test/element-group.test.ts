import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `element group / ungroup / align / distribute / name set / copy / paste /
 * duplicate` (NOOP-113, T6), driven end-to-end through the CLI's own command
 * registry against a real temp presentation — same pattern as
 * `element.test.ts` (per-test CO_MOTION_HOME, dispatch through
 * `createDefaultRegistry()`, read back with `cat`).
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

async function readSlide(id: string, slidePath = "slides/001.svg"): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: slidePath });
  return result.data!.content;
}

/** A fresh presentation, converted to the compliant `<g>`-container form. */
async function openConvertedPresentation(): Promise<{ id: string; titleId: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "群組與組織測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const converted = await registry.dispatch<{ slides: Array<{ changed: boolean }> }>("convert", { id });
  expect(converted.ok).toBe(true);
  const svg = await readSlide(id);
  const match = /<g id="(el-[^"]+)"/.exec(svg);
  if (!match) throw new Error("test fixture: converted title container id not found");
  return { id, titleId: match[1] };
}

describe("element group", () => {
  it("wraps two same-layer elements in a new <g> with no transform of its own; children's transforms untouched; result is compliant", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 10, y: 10, width: 5, height: 5,
    });
    const b = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 100, y: 100, width: 5, height: 5,
    });

    const result = await registry.dispatch<{ elementId: string }>("element group", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId, b.data!.elementId],
    });

    expect(result.ok).toBe(true);
    const groupId = result.data!.elementId;
    const svg = await readSlide(id);
    expect(svg).toContain(`<g id="${groupId}">`);
    expect(svg).not.toContain(`<g id="${groupId}" transform`);
    expect(svg).toContain(`id="${a.data!.elementId}" transform="translate(10 10)"`);
    expect(svg).toContain(`id="${b.data!.elementId}" transform="translate(100 100)"`);

    const { checkSlideCompliance } = await import("@co-motion/core");
    expect(checkSlideCompliance(svg)).toEqual([]);
  });

  it("rejects targets in different parent containers, leaving the SVG byte-for-byte unchanged", async () => {
    const { id } = await openConvertedPresentation();
    const svgBefore = await readSlide(id);
    // Hand-build: el-outer is top-level, el-inner is nested inside a group — different parents.
    const groupSvg = svgBefore.replace(
      "</svg>",
      '<g id="el-outer"><rect x="0" y="0" width="1" height="1"/></g>' +
        '<g id="el-wrap"><g id="el-inner"><rect x="0" y="0" width="1" height="1"/></g></g></svg>',
    );
    const { writePresentationFile } = await import("@co-motion/core");
    await writePresentationFile(id, "slides/001.svg", groupSvg);
    const before = await readSlide(id);

    const result = await registry.dispatch("element group", {
      id, slidePath: "slides/001.svg", elementIds: ["el-outer", "el-inner"],
    });

    expect(result.ok).toBe(false);
    expect(await readSlide(id)).toBe(before);
  });
});

describe("element ungroup", () => {
  it("folds the group's translate into each child, leaving absolute bounds unchanged", async () => {
    const { id } = await openConvertedPresentation();
    const svgBefore = await readSlide(id);
    const groupSvg = svgBefore.replace(
      "</svg>",
      '<g id="el-group" transform="translate(100 50)">' +
        '<g id="el-child-a" transform="translate(5 5)"><rect x="0" y="0" width="10" height="10"/></g>' +
        '<g id="el-child-b" transform="translate(20 20)"><rect x="0" y="0" width="4" height="4"/></g>' +
        "</g></svg>",
    );
    const { writePresentationFile, elementBounds, parseSlide } = await import("@co-motion/core");
    await writePresentationFile(id, "slides/001.svg", groupSvg);

    const before = parseSlide(groupSvg, "slides/001.svg");
    const beforeGroup = before.elements.find((element) => element.id === "el-group")!;
    const beforeBounds = elementBounds(beforeGroup);

    const result = await registry.dispatch("element ungroup", {
      id, slidePath: "slides/001.svg", elementIds: ["el-group"],
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).not.toContain('id="el-group"');
    // The group's translate(100 50) is folded into each child's own translate.
    expect(svg).toContain('id="el-child-a" transform="translate(105 55)"');
    expect(svg).toContain('id="el-child-b" transform="translate(120 70)"');

    const after = parseSlide(svg, "slides/001.svg");
    const afterA = after.elements.find((element) => element.id === "el-child-a")!;
    const afterB = after.elements.find((element) => element.id === "el-child-b")!;
    const boundsA = elementBounds(afterA);
    const boundsB = elementBounds(afterB);
    const { unionRects } = await import("@co-motion/core");
    const afterUnion = unionRects([boundsA, boundsB]);
    expect(afterUnion).toEqual(beforeBounds);
  });

  it("rejects a target that is not a group", async () => {
    const { id, titleId } = await openConvertedPresentation();
    const before = await readSlide(id);

    const result = await registry.dispatch("element ungroup", { id, slidePath: "slides/001.svg", elementIds: [titleId] });

    expect(result.ok).toBe(false);
    expect(await readSlide(id)).toBe(before);
  });
});

describe("element group then element scale (matches docs/multi-element-addressing.md's recursive rule)", () => {
  it("scaling the group scales children's translate and leaf native attributes; group's own transform (none) stays put", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 5, y: 5, width: 10, height: 10,
    });
    const b = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 20, y: 20, width: 4, height: 4,
    });
    const grouped = await registry.dispatch<{ elementId: string }>("element group", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId, b.data!.elementId],
    });
    const groupId = grouped.data!.elementId;

    const result = await registry.dispatch("element scale", { id, slidePath: "slides/001.svg", elementIds: [groupId], factor: 2 });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`<g id="${groupId}">`);
    expect(svg).not.toContain(`<g id="${groupId}" transform`);
    expect(svg).toContain(`id="${a.data!.elementId}" transform="translate(10 10)"`);
    expect(svg).toContain(`id="${b.data!.elementId}" transform="translate(40 40)"`);
    expect(svg).toContain('width="20" height="20"');
    expect(svg).toContain('width="8" height="8"');
  });
});

describe("element align", () => {
  it("left aligns all targets to the original minimum x", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 10, y: 0, width: 10, height: 10,
    });
    const b = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 50, y: 20, width: 10, height: 10,
    });
    const c = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 30, y: 40, width: 10, height: 10,
    });

    const result = await registry.dispatch("element align", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId, b.data!.elementId, c.data!.elementId], direction: "left",
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    // Minimum x among the three was 10 (a's own x).
    expect(svg).toContain(`id="${a.data!.elementId}" transform="translate(10 0)"`);
    expect(svg).toContain(`id="${b.data!.elementId}" transform="translate(10 20)"`);
    expect(svg).toContain(`id="${c.data!.elementId}" transform="translate(10 40)"`);
  });

  it("fails with a text-box target, mentioning the bounding box, leaving the SVG unchanged", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const textBox = await registry.dispatch<{ elementId: string }>("textbox add", {
      id, slidePath: "slides/001.svg", x: 0, y: 0, width: 100, text: "abc", fontSize: 20, fontFamily: "Noto Sans TC",
    });
    const before = await readSlide(id);

    const result = await registry.dispatch("element align", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId, textBox.data!.elementId], direction: "left",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("邊界框");
    expect(await readSlide(id)).toBe(before);
  });
});

describe("element distribute", () => {
  it("equalizes bbox center spacing along horizontal; first/last stay fixed", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const b = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 40, y: 0, width: 10, height: 10,
    });
    const c = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 100, y: 0, width: 10, height: 10,
    });
    // Centers: a=5, b=45, c=105. Equal spacing puts b's center at (5+105)/2=55, i.e. x=50.

    const result = await registry.dispatch("element distribute", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId, b.data!.elementId, c.data!.elementId], axis: "horizontal",
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`id="${a.data!.elementId}" transform="translate(0 0)"`);
    expect(svg).toContain(`id="${b.data!.elementId}" transform="translate(50 0)"`);
    expect(svg).toContain(`id="${c.data!.elementId}" transform="translate(100 0)"`);
  });

  it("fails with only two targets", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const b = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 40, y: 0, width: 10, height: 10,
    });

    const result = await registry.dispatch("element distribute", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId, b.data!.elementId], axis: "horizontal",
    });

    expect(result.ok).toBe(false);
  });
});

describe("element name set", () => {
  it("sets data-comot-name on the container, leaving the primitive untouched; empty string removes it", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10, fill: "#abcdef",
    });
    const elementId = a.data!.elementId;

    const result = await registry.dispatch("element name set", {
      id, slidePath: "slides/001.svg", elementIds: [elementId], name: "我的矩形",
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`data-comot-name="我的矩形" id="${elementId}" transform="translate(0 0)"`);
    expect(svg).toContain('<rect x="0" y="0" width="10" height="10" fill="#abcdef"/>');

    const cleared = await registry.dispatch("element name set", { id, slidePath: "slides/001.svg", elementIds: [elementId], name: "" });
    expect(cleared.ok).toBe(true);
    const svgAfterClear = await readSlide(id);
    // The converted title's own data-comot-name is untouched; only our target's is removed.
    expect(svgAfterClear).toContain(`<g id="${elementId}" transform="translate(0 0)">`);
  });
});

/** A two-slide presentation, hand-built as a `.comot` container (`new` only ever creates one slide) — following `element.test.ts:419`'s manual `zipSync` technique. */
async function openTwoSlidePresentation(options: { slide1Effects?: string } = {}): Promise<{ id: string }> {
  const effectsBlock = options.slide1Effects
    ? `<metadata><comot:effects xmlns:comot="https://schemas.comotion.app/effects">${options.slide1Effects}</comot:effects></metadata>`
    : "";
  const slide1 =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${effectsBlock}` +
    '<g id="el-a" transform="translate(10 20)"><rect x="0" y="0" width="5" height="5"/></g>' +
    "</svg>";
  const slide2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>';
  const { zipSync } = await import("fflate");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        name: "clipboard fixture",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg", "slides/002.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode(slide1),
    "slides/002.svg": new TextEncoder().encode(slide2),
  });
  const comotPath = path.join(comotDir, "clip.comot");
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

describe("element copy / paste", () => {
  it("copy from slide 1, paste onto a DIFFERENT slide: new id, source unchanged, one undo reverts the paste", async () => {
    const { id } = await openTwoSlidePresentation();
    const beforeSource = await readSlide(id, "slides/001.svg");
    const beforeTarget = await readSlide(id, "slides/002.svg");

    const copied = await registry.dispatch("element copy", { id, slidePath: "slides/001.svg", elementIds: ["el-a"] });
    expect(copied.ok).toBe(true);
    expect(await readSlide(id, "slides/001.svg")).toBe(beforeSource); // copy never mutates

    const pasted = await registry.dispatch<{ elementIds: string[] }>("element paste", {
      id, slidePath: "slides/002.svg", dx: 0, dy: 0,
    });

    expect(pasted.ok).toBe(true);
    const newId = pasted.data!.elementIds[0];
    expect(newId).not.toBe("el-a");
    const targetAfterPaste = await readSlide(id, "slides/002.svg");
    expect(targetAfterPaste).toContain(`id="${newId}"`);
    expect(await readSlide(id, "slides/001.svg")).toBe(beforeSource);

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    expect(await readSlide(id, "slides/002.svg")).toBe(beforeTarget);
    expect(await readSlide(id, "slides/001.svg")).toBe(beforeSource);
  });

  it("migrates only the effect targeting the copied element, appended at the end of the target slide's effect list", async () => {
    const { id } = await openTwoSlidePresentation({
      slide1Effects: '<comot:effect target="el-a" kind="fade"/><comot:effect target="el-other" kind="fade"/>',
    });

    await registry.dispatch("element copy", { id, slidePath: "slides/001.svg", elementIds: ["el-a"] });
    const pasted = await registry.dispatch<{ elementIds: string[] }>("element paste", {
      id, slidePath: "slides/002.svg", dx: 0, dy: 0,
    });
    expect(pasted.ok).toBe(true);
    const newId = pasted.data!.elementIds[0];

    const svg2 = await readSlide(id, "slides/002.svg");
    const effectMatches = [...svg2.matchAll(/<comot:effect target="([^"]+)"/g)];
    expect(effectMatches.length).toBe(1);
    expect(effectMatches[effectMatches.length - 1][1]).toBe(newId);
  });

  it("deleting the pasted element cleans up its migrated effect, without touching an unrelated one", async () => {
    const { id } = await openTwoSlidePresentation({
      slide1Effects: '<comot:effect target="el-a" kind="fade"/><comot:effect target="el-other" kind="fade"/>',
    });
    await registry.dispatch("element copy", { id, slidePath: "slides/001.svg", elementIds: ["el-a"] });
    const pasted = await registry.dispatch<{ elementIds: string[] }>("element paste", {
      id, slidePath: "slides/002.svg", dx: 0, dy: 0,
    });
    const newId = pasted.data!.elementIds[0];

    const result = await registry.dispatch("element delete", { id, slidePath: "slides/002.svg", elementIds: [newId] });

    expect(result.ok).toBe(true);
    const svg2 = await readSlide(id, "slides/002.svg");
    expect(svg2).not.toContain(`target="${newId}"`);
    expect(svg2).not.toContain(`id="${newId}"`);

    // The other slide's own effect referencing el-other is untouched (never in scope of this paste).
    const svg1 = await readSlide(id, "slides/001.svg");
    expect(svg1).toContain('target="el-other"');
  });

  it("a source element deleted after copy still pastes fine — the clipboard is a snapshot, not a live reference", async () => {
    const { id } = await openTwoSlidePresentation();
    await registry.dispatch("element copy", { id, slidePath: "slides/001.svg", elementIds: ["el-a"] });
    await registry.dispatch("element delete", { id, slidePath: "slides/001.svg", elementIds: ["el-a"] });

    const pasted = await registry.dispatch<{ elementIds: string[] }>("element paste", {
      id, slidePath: "slides/002.svg", dx: 0, dy: 0,
    });

    expect(pasted.ok).toBe(true);
    const svg2 = await readSlide(id, "slides/002.svg");
    expect(svg2).toContain(`id="${pasted.data!.elementIds[0]}"`);
  });

  it("paste on a slide never copied to fails, mentioning the clipboard", async () => {
    const { id } = await openTwoSlidePresentation();

    const result = await registry.dispatch("element paste", { id, slidePath: "slides/002.svg", dx: 0, dy: 0 });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("剪貼簿");
  });
});

describe("element duplicate", () => {
  it("offsets the new copy by dx/dy and never overwrites the clipboard saved by an earlier copy", async () => {
    const { id } = await openTwoSlidePresentation();
    const copied = await registry.dispatch("element copy", { id, slidePath: "slides/001.svg", elementIds: ["el-a"] });
    expect(copied.ok).toBe(true);

    const duplicated = await registry.dispatch<{ elementIds: string[] }>("element duplicate", {
      id, slidePath: "slides/001.svg", elementIds: ["el-a"], dx: 10, dy: 10,
    });
    expect(duplicated.ok).toBe(true);
    const dupId = duplicated.data!.elementIds[0];
    const svg1 = await readSlide(id, "slides/001.svg");
    // el-a's own translate was (10 20); the duplicate lands at (20 30).
    expect(svg1).toContain(`id="${dupId}" transform="translate(20 30)"`);

    // The clipboard saved by "element copy" above is untouched by duplicate:
    // pasting still yields el-a's own (un-offset) content, not the duplicate's.
    const pasted = await registry.dispatch<{ elementIds: string[] }>("element paste", {
      id, slidePath: "slides/002.svg", dx: 0, dy: 0,
    });
    expect(pasted.ok).toBe(true);
    const svg2 = await readSlide(id, "slides/002.svg");
    expect(svg2).toContain(`id="${pasted.data!.elementIds[0]}" transform="translate(10 20)"`);
  });
});
