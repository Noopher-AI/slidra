import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  IDENTITY,
  applyMatrixToPoint,
  composeMatrices,
  decomposeMatrix,
  formatTransform,
  invertMatrix,
  multiplyMatrix,
  parseTransform,
} from "../src/geometry/transform.js";
import {
  absolutePosition,
  elementBounds,
  pathBounds,
  primitiveBounds,
  transformRect,
  unionRects,
} from "../src/geometry/bbox.js";
import type { SlideElement, SlidePrimitive } from "../src/slide/format.js";

// Expected matrices below come from the SVG 1.1 spec's own definitions of
// each transform function (§7.4 "The transform attribute"), not from
// running this implementation.
describe("parseTransform", () => {
  it("treats a missing transform attribute as the identity matrix, not a special case", () => {
    expect(parseTransform(null)).toEqual(IDENTITY);
    expect(parseTransform(undefined)).toEqual(IDENTITY);
    expect(parseTransform("   ")).toEqual(IDENTITY);
  });

  it("reads translate(tx ty) as matrix(1 0 0 1 tx ty)", () => {
    expect(parseTransform("translate(10 20)")).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
  });

  it("reads translate(tx) with ty defaulting to 0, as the spec requires", () => {
    expect(parseTransform("translate(10)")).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 });
  });

  it("reads scale(sx sy) and the one-argument uniform form", () => {
    expect(parseTransform("scale(2 3)")).toEqual({ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
    expect(parseTransform("scale(2)")).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
  });

  it("reads rotate(90) as matrix(0 1 -1 0 0 0)", () => {
    const m = parseTransform("rotate(90)");
    expect(m.a).toBeCloseTo(0, 12);
    expect(m.b).toBeCloseTo(1, 12);
    expect(m.c).toBeCloseTo(-1, 12);
    expect(m.d).toBeCloseTo(0, 12);
    expect(m.e).toBeCloseTo(0, 12);
    expect(m.f).toBeCloseTo(0, 12);
  });

  it("reads rotate(angle cx cy) as a rotation about (cx cy): (100 100) stays put under rotate(90 100 100)", () => {
    const m = parseTransform("rotate(90 100 100)");
    const fixed = applyMatrixToPoint(m, { x: 100, y: 100 });
    expect(fixed.x).toBeCloseTo(100, 9);
    expect(fixed.y).toBeCloseTo(100, 9);
    // A point 10 to the right of the centre rotates to 10 below it.
    const moved = applyMatrixToPoint(m, { x: 110, y: 100 });
    expect(moved.x).toBeCloseTo(100, 9);
    expect(moved.y).toBeCloseTo(110, 9);
  });

  it("reads matrix(a b c d e f) verbatim", () => {
    expect(parseTransform("matrix(1 2 3 4 5 6)")).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
  });

  it("reads skewX(45) as matrix(1 0 1 1 0 0) and skewY(45) as matrix(1 1 0 1 0 0)", () => {
    const x = parseTransform("skewX(45)");
    expect(x.a).toBeCloseTo(1, 12);
    expect(x.b).toBeCloseTo(0, 12);
    expect(x.c).toBeCloseTo(1, 12);
    expect(x.d).toBeCloseTo(1, 12);
    const y = parseTransform("skewY(45)");
    expect(y.a).toBeCloseTo(1, 12);
    expect(y.b).toBeCloseTo(1, 12);
    expect(y.c).toBeCloseTo(0, 12);
    expect(y.d).toBeCloseTo(1, 12);
  });

  it("applies a chain left to right: translate then scale means the scale happens in the translated frame", () => {
    // SVG: transform="translate(10 20) scale(2)" maps (1 1) to (12 22).
    const m = parseTransform("translate(10 20) scale(2)");
    expect(applyMatrixToPoint(m, { x: 1, y: 1 })).toEqual({ x: 12, y: 22 });
  });

  it("accepts commas and extra whitespace between arguments and between functions", () => {
    expect(parseTransform("  translate( 10 , 20 ) , scale( 2 , 2 ) ")).toEqual(
      parseTransform("translate(10 20) scale(2 2)"),
    );
  });

  it("throws on an unknown transform function instead of ignoring it", () => {
    expect(() => parseTransform("wobble(3)")).toThrow(CoMotionError);
    expect(() => parseTransform("wobble(3)")).toThrow(/wobble/);
  });

  it("throws when a known function gets the wrong number of arguments", () => {
    expect(() => parseTransform("translate(1 2 3)")).toThrow(CoMotionError);
    expect(() => parseTransform("matrix(1 2 3)")).toThrow(CoMotionError);
    expect(() => parseTransform("rotate()")).toThrow(CoMotionError);
  });

  it("throws when an argument is not a number", () => {
    expect(() => parseTransform("translate(10px 20)")).toThrow(CoMotionError);
  });

  it("throws when a parenthesis is never closed", () => {
    expect(() => parseTransform("translate(10 20")).toThrow(CoMotionError);
  });
});

describe("multiplyMatrix / composeMatrices", () => {
  it("multiplies outer ∘ inner: <g transform=A><g transform=B> maps a point by A then B's own frame", () => {
    const outer = parseTransform("translate(100 0)");
    const inner = parseTransform("scale(2)");
    expect(applyMatrixToPoint(multiplyMatrix(outer, inner), { x: 3, y: 4 })).toEqual({ x: 106, y: 8 });
  });

  it("composes an empty chain to the identity", () => {
    expect(composeMatrices([])).toEqual(IDENTITY);
  });

  it("composes a root-to-leaf chain in that order", () => {
    const chain = [parseTransform("translate(100 0)"), parseTransform("translate(0 50)")];
    expect(composeMatrices(chain)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 });
  });
});

describe("invertMatrix", () => {
  it("undoes a transform: inverse applied after the original returns the original point", () => {
    const m = parseTransform("translate(10 20) rotate(30) scale(2 4)");
    const p = { x: 7, y: -3 };
    const round = applyMatrixToPoint(invertMatrix(m), applyMatrixToPoint(m, p));
    expect(round.x).toBeCloseTo(7, 9);
    expect(round.y).toBeCloseTo(-3, 9);
  });

  it("throws on a degenerate matrix rather than returning a repaired one", () => {
    expect(() => invertMatrix(parseTransform("scale(0)"))).toThrow(CoMotionError);
  });
});

describe("decomposeMatrix", () => {
  it("recovers the translate, rotate and scale that were written into the transform", () => {
    const parts = decomposeMatrix(parseTransform("translate(640 330) rotate(-15) scale(2 3)"));
    expect(parts.translateX).toBeCloseTo(640, 9);
    expect(parts.translateY).toBeCloseTo(330, 9);
    expect(parts.rotation).toBeCloseTo(-15, 9);
    expect(parts.scaleX).toBeCloseTo(2, 9);
    expect(parts.scaleY).toBeCloseTo(3, 9);
  });

  it("decomposes the identity to zero translation, zero rotation and unit scale", () => {
    expect(decomposeMatrix(IDENTITY)).toEqual({
      translateX: 0,
      translateY: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    });
  });

  it("recovers a negative scale (a mirrored element) rather than folding it into the rotation", () => {
    const parts = decomposeMatrix(parseTransform("scale(1 -1)"));
    expect(parts.rotation).toBeCloseTo(0, 9);
    expect(parts.scaleX).toBeCloseTo(1, 9);
    expect(parts.scaleY).toBeCloseTo(-1, 9);
  });

  it("throws on a skewed matrix instead of inventing a rotation and scale for it", () => {
    expect(() => decomposeMatrix(parseTransform("skewX(20)"))).toThrow(CoMotionError);
    expect(() => decomposeMatrix(parseTransform("skewX(20)"))).toThrow(/傾斜/);
  });
});

describe("formatTransform", () => {
  it("writes the segments in translate rotate scale order", () => {
    expect(
      formatTransform({ translateX: 640, translateY: 330, rotation: -15, scaleX: 2, scaleY: 3 }),
    ).toBe("translate(640 330) rotate(-15) scale(2 3)");
  });

  it("omits segments that are at their default value", () => {
    expect(formatTransform({ translateX: 640, translateY: 330, rotation: 0, scaleX: 1, scaleY: 1 })).toBe(
      "translate(640 330)",
    );
    expect(formatTransform({ translateX: 0, translateY: 0, rotation: -15, scaleX: 1, scaleY: 1 })).toBe(
      "rotate(-15)",
    );
  });

  it("returns the empty string when everything is at its default, so the caller writes no attribute at all", () => {
    expect(formatTransform({ translateX: 0, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1 })).toBe("");
  });

  it("rounds to 4 decimal places and drops trailing zeros (軍令: transform 精度)", () => {
    expect(
      formatTransform({
        translateX: 1 / 3,
        translateY: 10.500000001,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
      }),
    ).toBe("translate(0.3333 10.5)");
  });

  it("never writes -0", () => {
    expect(formatTransform({ translateX: -0.00001, translateY: 0, rotation: 0, scaleX: 1, scaleY: 1 })).toBe("");
  });
});

// --- bounding boxes -------------------------------------------------------

const primitive = (tag: string, attrs: Record<string, string>): SlidePrimitive => ({
  tag,
  attrs: new Map(Object.entries(attrs)),
  text: "",
  tspanCount: 0,
});

const element = (over: Partial<SlideElement> & Pick<SlideElement, "id" | "kind">): SlideElement => ({
  name: null,
  media: null,
  transform: null,
  matrix: IDENTITY,
  children: [],
  primitives: [],
  textWidth: null,
  textHeight: null,
  ...over,
});

describe("primitiveBounds", () => {
  it("boxes a rect from its own x/y/width/height", () => {
    expect(primitiveBounds(primitive("rect", { x: "10", y: "20", width: "30", height: "40" }))).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it("lets x and y default to 0, as SVG itself does", () => {
    expect(primitiveBounds(primitive("rect", { width: "1280", height: "720" }))).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("boxes a circle as the square around its radius", () => {
    expect(primitiveBounds(primitive("circle", { cx: "960", cy: "370", r: "70" }))).toEqual({
      x: 890,
      y: 300,
      width: 140,
      height: 140,
    });
  });

  it("boxes an ellipse from rx/ry", () => {
    expect(primitiveBounds(primitive("ellipse", { cx: "0", cy: "0", rx: "5", ry: "3" }))).toEqual({
      x: -5,
      y: -3,
      width: 10,
      height: 6,
    });
  });

  it("boxes a line regardless of which end comes first", () => {
    expect(primitiveBounds(primitive("line", { x1: "30", y1: "20", x2: "10", y2: "40" }))).toEqual({
      x: 10,
      y: 20,
      width: 20,
      height: 20,
    });
  });

  it("boxes an image from x/y/width/height", () => {
    expect(
      primitiveBounds(primitive("image", { href: "../assets/photo.svg", x: "490", y: "220", width: "300", height: "300" })),
    ).toEqual({ x: 490, y: 220, width: 300, height: 300 });
  });

  // E2.T12 — a chart's rendered `<svg>` boxes like `rect`/`image`: no
  // native `x`/`y` (it defaults to 0, exactly as SVG itself does), width
  // and height are required.
  it("boxes a chart's embedded <svg> from width/height, x/y defaulting to 0", () => {
    expect(primitiveBounds(primitive("svg", { width: "486.4", height: "475.2" }))).toEqual({
      x: 0,
      y: 0,
      width: 486.4,
      height: 475.2,
    });
  });

  it("returns a zero-sized box for a zero-sized element rather than throwing", () => {
    expect(primitiveBounds(primitive("rect", { x: "5", y: "5", width: "0", height: "0" }))).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });

  it("throws, naming the element and the attribute, when a required attribute is missing", () => {
    expect(() => primitiveBounds(primitive("rect", { x: "0", y: "0", height: "10" }))).toThrow(/rect.*width/);
  });

  it("rejects a percentage size: a percentage has no single answer inside a container chain", () => {
    expect(() => primitiveBounds(primitive("rect", { width: "10%", height: "10" }))).toThrow(CoMotionError);
  });

  it("refuses to box a text element, pointing at the font metrics ticket", () => {
    expect(() => primitiveBounds(primitive("text", { x: "0", y: "0" }))).toThrow(
      "尚無法計算文字元素的邊界框：待 #76 的字型度量落地",
    );
  });
});

describe("pathBounds", () => {
  // demo/slides/004.svg's speaker path, whose extreme x/y are all explicit
  // line endpoints — read straight off the `d` string, not computed here.
  it("boxes a polyline path from its endpoints", () => {
    expect(pathBounds("M935 340 L935 400 L955 400 L985 425 L985 315 L955 340 Z")).toEqual({
      x: 935,
      y: 315,
      width: 50,
      height: 110,
    });
  });

  // A symmetric cubic from (0 0) to (100 0) with both control points at
  // y=100 reaches y = 3/4 · 100 = 75 at t = 0.5 (standard Bézier result),
  // never y = 100. A control-point box would wrongly say height 100.
  it("boxes a cubic at the curve's real extreme, not at its control points", () => {
    expect(pathBounds("M0 0 C0 100 100 100 100 0")).toEqual({ x: 0, y: 0, width: 100, height: 75 });
  });

  // A quadratic with its control point at y=100 peaks at y = 50 (t = 0.5).
  it("boxes a quadratic at the curve's real extreme", () => {
    expect(pathBounds("M0 0 Q50 100 100 0")).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("reads relative commands against the current point", () => {
    expect(pathBounds("M10 10 l20 0 l0 20 z")).toEqual({ x: 10, y: 10, width: 20, height: 20 });
  });

  it("treats numbers following an M as an implicit lineto, as the SVG grammar requires", () => {
    expect(pathBounds("M0 0 10 40")).toEqual({ x: 0, y: 0, width: 10, height: 40 });
  });

  it("throws on an elliptical arc rather than returning an approximate box", () => {
    expect(() => pathBounds("M0 0 A10 10 0 0 1 20 0")).toThrow(/橢圓弧/);
  });

  it("throws when a command is short of arguments", () => {
    expect(() => pathBounds("M0 0 L10")).toThrow(CoMotionError);
  });
});

describe("transformRect", () => {
  it("returns the axis-aligned box after the transform, not the rotated rectangle", () => {
    const rotated = transformRect(parseTransform("rotate(45)"), { x: -1, y: -1, width: 2, height: 2 });
    // A 2×2 square centred on the origin, turned 45°, spans ±√2 on both axes.
    expect(rotated.x).toBeCloseTo(-Math.SQRT2, 9);
    expect(rotated.y).toBeCloseTo(-Math.SQRT2, 9);
    expect(rotated.width).toBeCloseTo(2 * Math.SQRT2, 9);
    expect(rotated.height).toBeCloseTo(2 * Math.SQRT2, 9);
  });
});

describe("unionRects", () => {
  it("covers every rectangle given", () => {
    expect(
      unionRects([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: -5, width: 5, height: 5 },
      ]),
    ).toEqual({ x: 0, y: -5, width: 25, height: 15 });
  });

  it("throws on an empty list instead of returning an empty rectangle", () => {
    expect(() => unionRects([])).toThrow(CoMotionError);
  });
});

describe("elementBounds / absolutePosition", () => {
  // 軍令: conversion wraps but never hoists, so the absolute position is
  // the container chain's matrix applied to the primitive's native x/y.
  it("applies the container's own transform to the primitive's native geometry", () => {
    const rect = element({
      id: "el-a",
      kind: "rect",
      transform: "translate(100 200)",
      matrix: parseTransform("translate(100 200)"),
      primitives: [primitive("rect", { x: "10", y: "20", width: "30", height: "40" })],
    });
    expect(elementBounds(rect)).toEqual({ x: 110, y: 220, width: 30, height: 40 });
    expect(absolutePosition(rect)).toEqual({ x: 110, y: 220 });
  });

  it("multiplies the ancestor chain in front of the element's own transform", () => {
    const rect = element({
      id: "el-a",
      kind: "rect",
      matrix: parseTransform("translate(5 5)"),
      primitives: [primitive("rect", { x: "0", y: "0", width: "10", height: "10" })],
    });
    expect(elementBounds(rect, { ancestors: [parseTransform("scale(2)")] })).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    });
  });

  it("boxes a group as the union of its children, in the group's own frame", () => {
    const group = element({
      id: "el-group",
      kind: "group",
      matrix: parseTransform("translate(1000 0)"),
      children: [
        element({
          id: "el-a",
          kind: "rect",
          primitives: [primitive("rect", { x: "0", y: "0", width: "10", height: "10" })],
        }),
        element({
          id: "el-b",
          kind: "rect",
          primitives: [primitive("rect", { x: "40", y: "60", width: "10", height: "10" })],
        }),
      ],
    });
    expect(elementBounds(group)).toEqual({ x: 1000, y: 0, width: 50, height: 70 });
  });

  it("boxes a compound element as the union of all its primitives", () => {
    const compound = element({
      id: "el-audio-icon",
      kind: "compound",
      primitives: [
        primitive("circle", { cx: "960", cy: "370", r: "70" }),
        primitive("path", { d: "M935 340 L935 400 L955 400 L985 425 L985 315 L955 340 Z" }),
      ],
    });
    expect(elementBounds(compound)).toEqual({ x: 890, y: 300, width: 140, height: 140 });
  });
});
