import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `element insert / delete / move / scale / rotate / style set / order`
 * (#104), driven end-to-end through the CLI's own command registry against
 * a real temp presentation converted to the compliant container form —
 * following `packages/cli/test/commands.test.ts`'s pattern (per-test
 * CO_MOTION_HOME, dispatch through createDefaultRegistry(), read back with
 * `cat`).
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
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function readSlide(id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

/** A fresh presentation, converted to the compliant `<g>`-container form (title text lifted into `<g id="...">`). */
async function openConvertedPresentation(): Promise<{ id: string; titleId: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "元素編輯測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const converted = await registry.dispatch<{ slides: Array<{ changed: boolean }> }>("convert", { id });
  expect(converted.ok).toBe(true);
  const svg = await readSlide(id);
  const match = /<g id="(el-[^"]+)"/.exec(svg);
  if (!match) throw new Error("test fixture: converted title container id not found");
  return { id, titleId: match[1] };
}

describe("element insert", () => {
  it("inserts a rect as a new <g> container with translate(x y) and native x=0 y=0", async () => {
    const { id } = await openConvertedPresentation();

    const result = await registry.dispatch<{ elementId: string }>("element insert", {
      id,
      slidePath: "slides/001.svg",
      kind: "rect",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: "#ff0000",
    });

    expect(result.ok).toBe(true);
    const elementId = result.data!.elementId;
    const svg = await readSlide(id);
    expect(svg).toContain(
      `<g id="${elementId}" transform="translate(10 20)"><rect x="0" y="0" width="100" height="50" fill="#ff0000"/></g>`,
    );
  });

  it("rejects a width that is zero or negative", async () => {
    const { id } = await openConvertedPresentation();

    const result = await registry.dispatch("element insert", {
      id,
      slidePath: "slides/001.svg",
      kind: "rect",
      x: 0,
      y: 0,
      width: 0,
      height: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("element delete", () => {
  it("deletes a single element, with undo/redo round-tripping the change", async () => {
    const { id } = await openConvertedPresentation();
    const inserted = await registry.dispatch<{ elementId: string }>("element insert", {
      id,
      slidePath: "slides/001.svg",
      kind: "rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    const elementId = inserted.data!.elementId;
    const beforeDelete = await readSlide(id);
    expect(beforeDelete).toContain(elementId);

    const result = await registry.dispatch("element delete", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    expect(result.ok).toBe(true);
    const afterDelete = await readSlide(id);
    expect(afterDelete).not.toContain(elementId);

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    expect(await readSlide(id)).toBe(beforeDelete);

    const redone = await registry.dispatch("redo", { id });
    expect(redone.ok).toBe(true);
    expect(await readSlide(id)).toBe(afterDelete);
  });

  it("fails the whole command, deleting nothing, when any id in the list does not exist", async () => {
    const { id, titleId } = await openConvertedPresentation();
    const before = await readSlide(id);

    const result = await registry.dispatch("element delete", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [titleId, "el-does-not-exist"],
    });

    expect(result.ok).toBe(false);
    expect(await readSlide(id)).toBe(before);
  });
});

describe("element move", () => {
  it("adds dx/dy to the target's translate, and a second target's own translate independently", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 10, y: 10, width: 5, height: 5,
    });
    const b = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 100, y: 100, width: 5, height: 5,
    });

    const result = await registry.dispatch("element move", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId, b.data!.elementId], dx: 3, dy: -2,
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`id="${a.data!.elementId}" transform="translate(13 8)"`);
    expect(svg).toContain(`id="${b.data!.elementId}" transform="translate(103 98)"`);
  });

  it("undo restores the pre-move position", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 10, y: 10, width: 5, height: 5,
    });
    const before = await readSlide(id);

    await registry.dispatch("element move", { id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], dx: 3, dy: -2 });
    const afterMove = await readSlide(id);
    expect(afterMove).not.toBe(before);

    await registry.dispatch("undo", { id });
    expect(await readSlide(id)).toBe(before);

    await registry.dispatch("redo", { id });
    expect(await readSlide(id)).toBe(afterMove);
  });
});

describe("element scale", () => {
  it("scales a rect's width/height without moving its container transform", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 10, y: 10, width: 100, height: 50,
    });

    const result = await registry.dispatch("element scale", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], factor: 2,
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`id="${a.data!.elementId}" transform="translate(10 10)"`);
    expect(svg).toContain(`width="200" height="100"`);
  });

  it("rejects factor <= 0", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });

    const result = await registry.dispatch("element scale", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], factor: 0,
    });

    expect(result.ok).toBe(false);
  });

  it("scaling a group recurses: children's translate scales, container's own transform stays put", async () => {
    const { id } = await openConvertedPresentation();
    const svgBefore = await readSlide(id);
    // Hand-build a compliant group of two rects, appended after the title container.
    const groupSvg = svgBefore.replace(
      "</svg>",
      '<g id="el-group"><g id="el-child-a" transform="translate(5 5)"><rect x="0" y="0" width="10" height="10"/></g>' +
        '<g id="el-child-b" transform="translate(20 20)"><rect x="0" y="0" width="4" height="4"/></g></g></svg>',
    );
    const { writePresentationFile } = await import("@co-motion/core");
    await writePresentationFile(id, "slides/001.svg", groupSvg);

    const result = await registry.dispatch("element scale", {
      id, slidePath: "slides/001.svg", elementIds: ["el-group"], factor: 2,
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('<g id="el-group">');
    expect(svg).toContain('id="el-child-a" transform="translate(10 10)"');
    expect(svg).toContain('id="el-child-b" transform="translate(40 40)"');
    expect(svg).toContain('width="20" height="20"'); // el-child-a's rect
    expect(svg).toContain('width="8" height="8"'); // el-child-b's rect
  });

  it("undo/redo round-trips a scale", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const before = await readSlide(id);

    await registry.dispatch("element scale", { id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], factor: 3 });
    const after = await readSlide(id);
    expect(after).not.toBe(before);

    await registry.dispatch("undo", { id });
    expect(await readSlide(id)).toBe(before);
    await registry.dispatch("redo", { id });
    expect(await readSlide(id)).toBe(after);
  });
});

describe("element rotate", () => {
  it("adds degrees to the existing rotation", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 10, y: 10, width: 5, height: 5,
    });

    const result = await registry.dispatch("element rotate", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], degrees: 45,
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`id="${a.data!.elementId}" transform="translate(10 10) rotate(45)"`);
  });

  it("undo/redo round-trips a rotate", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const before = await readSlide(id);

    await registry.dispatch("element rotate", { id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], degrees: 30 });
    const after = await readSlide(id);
    expect(after).not.toBe(before);

    await registry.dispatch("undo", { id });
    expect(await readSlide(id)).toBe(before);
    await registry.dispatch("redo", { id });
    expect(await readSlide(id)).toBe(after);
  });
});

describe("element style set", () => {
  it("sets fill on the target's primitive", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });

    const result = await registry.dispatch("element style set", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], attr: "fill", value: "#123456",
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('fill="#123456"');
  });

  for (const attr of ["transform", "x", "y", "width", "height", "data-comot-name"]) {
    it(`rejects ${attr} (not in the style whitelist)`, async () => {
      const { id } = await openConvertedPresentation();
      const a = await registry.dispatch<{ elementId: string }>("element insert", {
        id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
      });

      const result = await registry.dispatch("element style set", {
        id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], attr, value: "1",
      });

      expect(result.ok).toBe(false);
    });
  }

  it("undo/redo round-trips a style set", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const before = await readSlide(id);

    await registry.dispatch("element style set", { id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], attr: "fill", value: "#abcdef" });
    const after = await readSlide(id);
    expect(after).not.toBe(before);

    await registry.dispatch("undo", { id });
    expect(await readSlide(id)).toBe(before);
    await registry.dispatch("redo", { id });
    expect(await readSlide(id)).toBe(after);
  });
});

describe("element order", () => {
  it("front moves the target to be painted last (topmost) among its siblings", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const b = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    // b was inserted after a, so b is already last; move a to front instead.
    const result = await registry.dispatch("element order", {
      id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], direction: "front",
    });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg.indexOf(b.data!.elementId)).toBeLessThan(svg.indexOf(a.data!.elementId));
  });

  it("undo/redo round-trips an order change", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const before = await readSlide(id);

    await registry.dispatch("element order", { id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], direction: "front" });
    const after = await readSlide(id);
    expect(after).not.toBe(before);

    await registry.dispatch("undo", { id });
    expect(await readSlide(id)).toBe(before);
    await registry.dispatch("redo", { id });
    expect(await readSlide(id)).toBe(after);
  });
});

describe("element scale / style set on a text box", () => {
  it("scaling a text box scales both its declared width and font-size, and re-wraps", async () => {
    const { id } = await openConvertedPresentation();
    const added = await registry.dispatch<{ elementId: string }>("textbox add", {
      id, slidePath: "slides/001.svg", x: 0, y: 0, width: 440, text: "文字框有寬度，文字寫滿就折到下一行。", fontSize: 40, fontFamily: "Noto Sans TC",
    });
    const elementId = added.data!.elementId;

    const result = await registry.dispatch("element scale", { id, slidePath: "slides/001.svg", elementIds: [elementId], factor: 0.5 });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('data-comot-text-width="220"');
    expect(svg).toContain('font-size="20"');
  });

  it("style set font-size on a text box re-wraps its content", async () => {
    const { id } = await openConvertedPresentation();
    const added = await registry.dispatch<{ elementId: string }>("textbox add", {
      id, slidePath: "slides/001.svg", x: 0, y: 0, width: 280, text: "文字框有寬度，文字寫滿就折到下一行。", fontSize: 40, fontFamily: "Noto Sans TC",
    });
    const elementId = added.data!.elementId;

    const result = await registry.dispatch("element style set", { id, slidePath: "slides/001.svg", elementIds: [elementId], attr: "font-size", value: "20" });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain('font-size="20"');
    expect(svg).toContain('data-comot-text-width="280"'); // width untouched by style set
  });

  it("style set text-anchor on a text box is rejected", async () => {
    const { id } = await openConvertedPresentation();
    const added = await registry.dispatch<{ elementId: string }>("textbox add", {
      id, slidePath: "slides/001.svg", x: 0, y: 0, width: 280, text: "abc", fontSize: 20, fontFamily: "Noto Sans TC",
    });

    const result = await registry.dispatch("element style set", {
      id, slidePath: "slides/001.svg", elementIds: [added.data!.elementId], attr: "text-anchor", value: "middle",
    });

    expect(result.ok).toBe(false);
  });
});

describe("element delete cleans up dangling effect references (ADR-0009 minimal schema)", () => {
  it("removes a <comot:effect> whose target names a deleted element", async () => {
    const slideSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:effects xmlns:comot="https://schemas.comotion.app/effects">' +
      '<comot:effect target="el-a" kind="fade"/><comot:effect target="el-b" kind="fade"/>' +
      "</comot:effects></metadata>" +
      '<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>' +
      '<g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>' +
      "</svg>";
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "effects fixture", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
      ),
      "slides/001.svg": new TextEncoder().encode(slideSvg),
    });
    const comotPath = path.join(comotDir, "effects.comot");
    await writeFile(comotPath, zipped);
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;

    const result = await registry.dispatch("element delete", { id, slidePath: "slides/001.svg", elementIds: ["el-a"] });

    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).not.toContain('target="el-a"');
    expect(svg).toContain('target="el-b"');
    expect(svg).not.toContain('id="el-a"');
    expect(svg).toContain('id="el-b"');
  });
});

describe("element scale rejects a path containing an elliptical arc", () => {
  it("throws instead of scaling the arc silently wrong", async () => {
    const { id } = await openConvertedPresentation();
    const inserted = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "path", d: "M10 10 A5 5 0 0 1 20 20", x: 0, y: 0,
    });

    const result = await registry.dispatch("element scale", {
      id, slidePath: "slides/001.svg", elementIds: [inserted.data!.elementId], factor: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("橢圓弧");
  });
});

describe("element insert — other kinds", () => {
  it("inserts a line with no container transform", async () => {
    const { id } = await openConvertedPresentation();
    const result = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "line", x1: 1, y1: 2, x2: 3, y2: 4,
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`<g id="${result.data!.elementId}"><line x1="1" y1="2" x2="3" y2="4"/></g>`);
  });

  it("inserts a line with --stroke/--stroke-width, without which it renders invisible", async () => {
    const { id } = await openConvertedPresentation();
    const result = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "line", x1: 1, y1: 2, x2: 3, y2: 4, stroke: "#889", strokeWidth: 2,
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`<line x1="1" y1="2" x2="3" y2="4" stroke="#889" stroke-width="2"/>`);
  });

  it("inserts an image with --media marking it as a placeholder (ADR-0005)", async () => {
    const { id } = await openConvertedPresentation();
    const result = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "image", x: 0, y: 0, width: 10, height: 10, href: "assets/foo.png", media: "assets/foo.png",
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`data-comot-media="assets/foo.png"`);
    expect(svg).toContain(`href="assets/foo.png"`);
  });

  it("inserts an ellipse with cx/cy/rx/ry derived from width/height", async () => {
    const { id } = await openConvertedPresentation();
    const result = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "ellipse", x: 0, y: 0, width: 20, height: 10,
    });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`<ellipse cx="10" cy="5" rx="10" ry="5"/>`);
  });
});

describe("element scale — ellipse/circle/line", () => {
  it("scales an ellipse's cx/cy/rx/ry", async () => {
    const { id } = await openConvertedPresentation();
    const inserted = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "ellipse", x: 0, y: 0, width: 20, height: 10,
    });
    const result = await registry.dispatch("element scale", { id, slidePath: "slides/001.svg", elementIds: [inserted.data!.elementId], factor: 2 });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`<ellipse cx="20" cy="10" rx="20" ry="10"/>`);
  });

  it("scales a line's endpoints", async () => {
    const { id } = await openConvertedPresentation();
    const inserted = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "line", x1: 1, y1: 2, x2: 3, y2: 4,
    });
    const result = await registry.dispatch("element scale", { id, slidePath: "slides/001.svg", elementIds: [inserted.data!.elementId], factor: 3 });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg).toContain(`x1="3" y1="6" x2="9" y2="12"`);
  });
});

describe("element order — up/down", () => {
  it("up swaps the target with the next sibling; a no-op at the edge changes nothing", async () => {
    const { id } = await openConvertedPresentation();
    const a = await registry.dispatch<{ elementId: string }>("element insert", { id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 1, height: 1 });
    const b = await registry.dispatch<{ elementId: string }>("element insert", { id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 1, height: 1 });
    const before = await readSlide(id);
    expect(before.indexOf(a.data!.elementId)).toBeLessThan(before.indexOf(b.data!.elementId));

    const result = await registry.dispatch("element order", { id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], direction: "up" });
    expect(result.ok).toBe(true);
    const svg = await readSlide(id);
    expect(svg.indexOf(b.data!.elementId)).toBeLessThan(svg.indexOf(a.data!.elementId));

    // b is now last; moving it further "up" (toward top) is a no-op.
    const atEdge = await registry.dispatch("element order", { id, slidePath: "slides/001.svg", elementIds: [a.data!.elementId], direction: "up" });
    expect(atEdge.ok).toBe(true);
    expect(await readSlide(id)).toBe(svg);
  });
});

describe("element cut", () => {
  it("removes the element from the slide and fills the clipboard so a paste brings it back with a new id", async () => {
    const { id } = await openConvertedPresentation();
    const inserted = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 10, y: 20, width: 100, height: 50,
    });
    const elementId = inserted.data!.elementId;
    const beforeCut = await readSlide(id);
    expect(beforeCut).toContain(elementId);

    const cut = await registry.dispatch("element cut", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    expect(cut.ok).toBe(true);
    const afterCut = await readSlide(id);
    expect(afterCut).not.toContain(elementId);

    const pasted = await registry.dispatch<{ elementIds: string[] }>("element paste", { id, slidePath: "slides/001.svg", dx: 0, dy: 0 });
    expect(pasted.ok).toBe(true);
    const newId = pasted.data!.elementIds[0];
    expect(newId).not.toBe(elementId);
    expect(await readSlide(id)).toContain(newId);
  });

  it("a single undo restores the cut element exactly; a second undo goes further back", async () => {
    const { id } = await openConvertedPresentation();
    const beforeInsert = await readSlide(id);
    const inserted = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const elementId = inserted.data!.elementId;
    const beforeCut = await readSlide(id);

    const cut = await registry.dispatch("element cut", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    expect(cut.ok).toBe(true);

    const undoneOnce = await registry.dispatch("undo", { id });
    expect(undoneOnce.ok).toBe(true);
    expect(await readSlide(id)).toBe(beforeCut);
    expect(await readSlide(id)).toContain(elementId);

    // A second undo reverts the insert itself, not "the rest of the cut" —
    // one command produced exactly one undo step.
    const undoneTwice = await registry.dispatch("undo", { id });
    expect(undoneTwice.ok).toBe(true);
    expect(await readSlide(id)).toBe(beforeInsert);
    expect(await readSlide(id)).not.toContain(elementId);
  });

  it("fails the whole command, cutting nothing and leaving the clipboard untouched, when any id does not exist", async () => {
    const { id } = await openConvertedPresentation();
    const inserted = await registry.dispatch<{ elementId: string }>("element insert", {
      id, slidePath: "slides/001.svg", kind: "rect", x: 0, y: 0, width: 10, height: 10,
    });
    const elementId = inserted.data!.elementId;
    // Seed the clipboard with a copy of a different, still-present element so
    // a bad cut overwriting it would be observable.
    await registry.dispatch("element copy", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const before = await readSlide(id);

    const result = await registry.dispatch("element cut", {
      id, slidePath: "slides/001.svg", elementIds: [elementId, "el-does-not-exist"],
    });

    expect(result.ok).toBe(false);
    expect(await readSlide(id)).toBe(before);

    // Clipboard still holds the earlier copy of elementId, not touched by
    // the failed cut.
    const pasted = await registry.dispatch<{ elementIds: string[] }>("element paste", {
      id, slidePath: "slides/001.svg", dx: 0, dy: 0,
    });
    expect(pasted.ok).toBe(true);
  });
});
