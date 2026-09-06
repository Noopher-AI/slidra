import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { resizeElements } from "../src/element-edit.js";
import { lockElements } from "../src/element-edit.js";
import { elementBounds } from "../src/geometry/bbox.js";
import { applyMatrixToPoint, parseTransform } from "../src/geometry/transform.js";
import { parseSlide } from "../src/slide/format.js";
import { parseFont, type FontMetrics } from "../src/text-metrics.js";

const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);

/**
 * `element resize` (NOOP-90/T2, new alongside the existing uniform
 * `element scale`) — non-uniform `--width --height --anchor`. Public
 * boundary under test is `resizeElements(svgContent, ...) -> svgContent`,
 * per the plan's §7.5 ("input SVG string -> output SVG string", not the
 * internal splice generators).
 */

const NO_FONTS: ReadonlyMap<string, FontMetrics> = new Map();
const SLIDE_PATH = "slides/001.svg";

function slide(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${inner}</svg>`;
}

describe("resizeElements — rect, anchor semantics", () => {
  it("anchor nw: the top-left corner (the container's own translate) does not move", () => {
    const svg = slide('<g id="el-a" transform="translate(10 20)"><rect x="0" y="0" width="100" height="50"/></g>');

    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "nw", NO_FONTS);

    expect(result).toContain('id="el-a" transform="translate(10 20)"');
    expect(result).toContain('width="200" height="100"');
  });

  it("anchor se: the bottom-right corner stays fixed, so translate shifts up-left as the box grows", () => {
    // Original box occupies x:[10,110], y:[20,70] — its SE corner is (110, 70).
    const svg = slide('<g id="el-a" transform="translate(10 20)"><rect x="0" y="0" width="100" height="50"/></g>');

    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "se", NO_FONTS);

    // sx = sy = 2, so the SE-anchor translate delta is (100-200, 50-100) = (-100, -50).
    expect(result).toContain('id="el-a" transform="translate(-90 -30)"');
    expect(result).toContain('width="200" height="100"');
    // The SE corner must land back on (110, 70): -90+200=110, -30+100=70.
  });

  it("anchor ne / sw: only one axis of translate shifts", () => {
    const svg = slide('<g id="el-a" transform="translate(10 20)"><rect x="0" y="0" width="100" height="50"/></g>');

    const ne = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "ne", NO_FONTS);
    // NE corner (110, 20) fixed: x delta = 100-200=-100 -> translateX=10-100=-90; y unaffected (nw-side of y).
    expect(ne).toContain('id="el-a" transform="translate(-90 20)"');

    const sw = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "sw", NO_FONTS);
    // SW corner (10, 70) fixed: y delta = 50-100=-50 -> translateY=20-50=-30; x unaffected.
    expect(sw).toContain('id="el-a" transform="translate(10 -30)"');
  });

  it("resizing to the same size is a no-op on translate (identity scale)", () => {
    const svg = slide('<g id="el-a" transform="translate(10 20)"><rect x="0" y="0" width="100" height="50"/></g>');

    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 100, 50, "se", NO_FONTS);

    expect(result).toContain('id="el-a" transform="translate(10 20)"');
    expect(result).toContain('width="100" height="50"');
  });

  it("rejects width <= 0", () => {
    const svg = slide('<g id="el-a" transform="translate(0 0)"><rect x="0" y="0" width="10" height="10"/></g>');
    expect(() => resizeElements(svg, SLIDE_PATH, ["el-a"], 0, 10, "nw", NO_FONTS)).toThrow(CoMotionError);
  });

  it("rejects a non-finite height", () => {
    const svg = slide('<g id="el-a" transform="translate(0 0)"><rect x="0" y="0" width="10" height="10"/></g>');
    expect(() => resizeElements(svg, SLIDE_PATH, ["el-a"], 10, Number.NaN, "nw", NO_FONTS)).toThrow(CoMotionError);
  });

  it("rejects an anchor outside nw/ne/sw/se", () => {
    const svg = slide('<g id="el-a" transform="translate(0 0)"><rect x="0" y="0" width="10" height="10"/></g>');
    expect(() => resizeElements(svg, SLIDE_PATH, ["el-a"], 20, 20, "center" as never, NO_FONTS)).toThrow(
      CoMotionError,
    );
  });

  it("anchor nw: a rect NOT anchored at local (0,0) still keeps its nw corner fixed (NOOP-91 round-2 FAIL #1)", () => {
    // rect's own local nw corner is (50, 20), not (0, 0) — the case that
    // exposed buildPrimitiveResizeSplices leaving a rect's x/y untouched
    // while resizeOneTarget's anchor delta assumes every primitive scales
    // about local (0, 0), exactly like ellipse's cx/cy already do.
    const svg = slide('<g id="el-a" transform="translate(100 100)"><rect x="50" y="20" width="100" height="50"/></g>');

    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "nw", NO_FONTS);

    // sx=sy=2: rect's own x/y now also scale (50->100, 20->40), and the
    // container's translate absorbs exactly the delta needed to keep the nw
    // corner — translate(100,100)+(50,20)=(150,120) before — landing back on
    // the same (150, 120) after: translate(50,80)+(100,40)=(150,120).
    expect(result).toContain('id="el-a" transform="translate(50 80)"');
    expect(result).toContain('<rect x="100" y="40" width="200" height="100"/>');

    const model = parseSlide(result, SLIDE_PATH);
    const element = model.elements.find((e) => e.id === "el-a")!;
    const nwAfter = applyMatrixToPoint(element.matrix, { x: 100, y: 40 });
    expect(nwAfter.x).toBeCloseTo(150, 6);
    expect(nwAfter.y).toBeCloseTo(120, 6);
  });

  it("anchor se: a rect NOT anchored at local (0,0) still keeps its se corner fixed (NOOP-91 round-2 FAIL #1)", () => {
    const svg = slide('<g id="el-a" transform="translate(100 100)"><rect x="50" y="20" width="100" height="50"/></g>');

    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "se", NO_FONTS);

    // se corner before: translate(100,100)+(50+100,20+50)=(250,170).
    // sx=sy=2: rect's own x/y scale to (100,40); translate absorbs the delta
    // so the se corner (x+width, y+height) lands back on the same (250,170).
    expect(result).toContain('<rect x="100" y="40" width="200" height="100"/>');
    const model = parseSlide(result, SLIDE_PATH);
    const element = model.elements.find((e) => e.id === "el-a")!;
    const seAfter = applyMatrixToPoint(element.matrix, { x: 100 + 200, y: 40 + 100 });
    expect(seAfter.x).toBeCloseTo(250, 6);
    expect(seAfter.y).toBeCloseTo(170, 6);
  });

  it("a rect with no x/y attribute at all (defaults to local origin 0,0) is unaffected by the x/y scaling fix", () => {
    const svg = slide('<g id="el-a" transform="translate(10 20)"><rect width="100" height="50"/></g>');

    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "nw", NO_FONTS);

    expect(result).toContain('id="el-a" transform="translate(10 20)"');
    expect(result).toContain('<rect width="200" height="100"/>');
    expect(result).not.toMatch(/<rect[^>]*\sx=/);
    expect(result).not.toMatch(/<rect[^>]*\sy=/);
  });

  it("rejects a locked target without --force, leaving the SVG unchanged", () => {
    const svg = slide('<g id="el-a" transform="translate(0 0)"><rect x="0" y="0" width="10" height="10"/></g>');
    const locked = lockElements(svg, SLIDE_PATH, ["el-a"]);

    expect(() => resizeElements(locked, SLIDE_PATH, ["el-a"], 20, 20, "nw", NO_FONTS)).toThrow(CoMotionError);
    const forced = resizeElements(locked, SLIDE_PATH, ["el-a"], 20, 20, "nw", NO_FONTS, { force: true });
    expect(forced).toContain('width="20" height="20"');
  });
});

describe("resizeElements — non-uniform on other primitive kinds", () => {
  it("ellipse: cx/cy/rx/ry each scale on their own axis", () => {
    const svg = slide('<g id="el-a"><ellipse cx="10" cy="5" rx="10" ry="5"/></g>');
    // Local bbox of the ellipse is x:[0,20] y:[0,10] -> width 20, height 10.
    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 40, 10, "nw", NO_FONTS);
    // sx=2, sy=1: cx 10->20, cy 5->5, rx 10->20, ry 5->5.
    expect(result).toContain('<ellipse cx="20" cy="5" rx="20" ry="5"/>');
  });

  it("line: endpoints scale per axis independently", () => {
    const svg = slide('<g id="el-a"><line x1="0" y1="0" x2="10" y2="20"/></g>');
    // Local bbox: x:[0,10] y:[0,20] -> width 10, height 20.
    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 20, 20, "nw", NO_FONTS);
    // sx=2, sy=1.
    expect(result).toContain('x1="0" y1="0" x2="20" y2="20"');
  });

  it("rejects a non-uniform resize of a <circle> (single-radius, no non-uniform representation)", () => {
    const svg = slide('<g id="el-a"><circle cx="5" cy="5" r="5"/></g>');
    expect(() => resizeElements(svg, SLIDE_PATH, ["el-a"], 20, 10, "nw", NO_FONTS)).toThrow(/circle/i);
  });

  it("allows a uniform resize of a <circle> (sx === sy)", () => {
    const svg = slide('<g id="el-a"><circle cx="5" cy="5" r="5"/></g>');
    const result = resizeElements(svg, SLIDE_PATH, ["el-a"], 20, 20, "nw", NO_FONTS);
    expect(result).toContain('<circle cx="10" cy="10" r="10"/>');
  });

  it("rejects a non-uniform resize of a <path>", () => {
    const svg = slide('<g id="el-a"><path d="M0 0 L10 0 L10 10 Z"/></g>');
    expect(() => resizeElements(svg, SLIDE_PATH, ["el-a"], 30, 10, "nw", NO_FONTS)).toThrow(/path/i);
  });

  it("rejects a non-uniform resize of an element containing <text>, naming element scale as the alternative", async () => {
    const font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    const fonts = new Map([["Noto Sans TC", font]]);
    const svg = slide(
      '<g id="el-a" data-comot-text-width="100" transform="translate(0 0)">' +
        '<text font-family="Noto Sans TC" font-size="20"><tspan x="0" y="18">A</tspan></text></g>',
    );
    expect(() => resizeElements(svg, SLIDE_PATH, ["el-a"], 300, 999, "nw", fonts)).toThrow(/element scale/);
  });
});

describe("resizeElements — group recursion", () => {
  it("scales descendants' translate per axis; the group's own translate gets only the anchor delta", () => {
    const svg = slide(
      '<g id="el-group" transform="translate(100 100)">' +
        '<g id="el-child-a" transform="translate(5 5)"><rect x="0" y="0" width="10" height="10"/></g>' +
        '<g id="el-child-b" transform="translate(20 20)"><rect x="0" y="0" width="4" height="4"/></g>' +
        "</g>",
    );
    // Local bbox of the group (its own transform factored out): union of
    // child-a's box [5,15]x[5,15] and child-b's box [20,24]x[20,24] -> x:[5,24] y:[5,24], width=19, height=19.
    const result = resizeElements(svg, SLIDE_PATH, ["el-group"], 38, 19, "nw", NO_FONTS);
    // sx=2, sy=1. Children's translate scales by (sx,sy); group's own NW corner (5,5) -> (10,5), delta=(-5,0).
    expect(result).toContain('id="el-group" transform="translate(95 100)"');
    expect(result).toContain('id="el-child-a" transform="translate(10 5)"');
    expect(result).toContain('id="el-child-b" transform="translate(40 20)"');
    expect(result).toContain('width="20" height="10"'); // child-a's rect: sx=2,sy=1 on 10x10
    expect(result).toContain('width="8" height="4"'); // child-b's rect: sx=2,sy=1 on 4x4
  });

  it("rejects a locked descendant even when only the outer group is named as the target", () => {
    const svg = slide(
      '<g id="el-group">' +
        '<g id="el-child" transform="translate(0 0)"><rect x="0" y="0" width="10" height="10"/></g>' +
        "</g>",
    );
    const locked = lockElements(svg, SLIDE_PATH, ["el-child"]);
    expect(() => resizeElements(locked, SLIDE_PATH, ["el-group"], 20, 10, "nw", NO_FONTS)).toThrow(CoMotionError);
  });
});

describe("resizeElements — rotation (the anchor corner is preserved in the parent's absolute frame)", () => {
  it("keeps the SE corner's absolute position fixed even though the container is rotated", () => {
    const svg = slide('<g id="el-r" transform="translate(50 50) rotate(30)"><rect x="0" y="0" width="40" height="20"/></g>');

    // Independently computed oracle: apply the ORIGINAL matrix to the shape's
    // own local SE corner (40, 20) — never resizeElements' own math.
    const originalMatrix = parseTransform("translate(50 50) rotate(30)");
    const seCornerBefore = applyMatrixToPoint(originalMatrix, { x: 40, y: 20 });

    const result = resizeElements(svg, SLIDE_PATH, ["el-r"], 80, 20, "se", NO_FONTS);

    const model = parseSlide(result, SLIDE_PATH);
    const element = model.elements.find((e) => e.id === "el-r")!;
    // The new local SE corner comes from the new rect's own width/height, and
    // element.matrix is this container's own (possibly shifted-translate) transform.
    const seCornerAfter = applyMatrixToPoint(element.matrix, { x: 80, y: 20 });

    // Tolerance accounts for `formatTransform`'s 4-decimal-place rounding.
    expect(seCornerAfter.x).toBeCloseTo(seCornerBefore.x, 3);
    expect(seCornerAfter.y).toBeCloseTo(seCornerBefore.y, 3);
    // Rotation itself is untouched.
    expect(result).toContain("rotate(30)");
  });
});

describe("resizeElements — multiple targets", () => {
  it("resizes each target independently to the same (width, height)", () => {
    const svg = slide(
      '<g id="el-a" transform="translate(0 0)"><rect x="0" y="0" width="10" height="10"/></g>' +
        '<g id="el-b" transform="translate(100 100)"><rect x="0" y="0" width="50" height="50"/></g>',
    );
    const result = resizeElements(svg, SLIDE_PATH, ["el-a", "el-b"], 20, 20, "nw", NO_FONTS);
    // el-a's translate is (0,0) both before and after nw-anchored resize —
    // `formatTransform` omits an all-zero translate, so no attribute at all.
    expect(result).toContain('<g id="el-a"><rect');
    expect(result).toContain('id="el-b" transform="translate(100 100)"');
    // Both anchored nw with no rotation, so both translates stay put; both end up 20x20.
    const widths = [...result.matchAll(/width="20" height="20"/g)];
    expect(widths.length).toBe(2);
  });

  it("undoes to the pre-resize bytes as a single change (via elementBounds, an independent read-back, not a snapshot of resizeElements' own output)", () => {
    const svg = slide('<g id="el-a" transform="translate(10 20)"><rect x="0" y="0" width="100" height="50"/></g>');
    const before = parseSlide(svg, SLIDE_PATH);
    const beforeBounds = elementBounds(before.elements[0]);

    const resized = resizeElements(svg, SLIDE_PATH, ["el-a"], 200, 100, "nw", NO_FONTS);
    const after = parseSlide(resized, SLIDE_PATH);
    const afterBounds = elementBounds(after.elements[0]);

    expect(afterBounds.x).toBeCloseTo(beforeBounds.x, 6);
    expect(afterBounds.y).toBeCloseTo(beforeBounds.y, 6);
    expect(afterBounds.width).toBeCloseTo(200, 6);
    expect(afterBounds.height).toBeCloseTo(100, 6);
  });
});
