// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { IDENTITY } from "../src/geometry.js";
import { cornerPoint, OPPOSITE_CORNER, rectsIntersect, subtreeForcesUniformScale } from "../src/canvas/gesture-geometry.js";
import type { SlideElement, SlideElementKind } from "../src/slide-dom.js";

/** Minimal `SlideElement` fixture — only the fields a given test cares about need overriding. */
function element(overrides: Partial<SlideElement> & { kind: SlideElementKind }): SlideElement {
  return {
    id: "el-1",
    name: null,
    media: null,
    transform: null,
    matrix: IDENTITY,
    children: [],
    primitives: [],
    textWidth: null,
    textHeight: null,
    textAlign: "left",
    locked: false,
    table: null,
    ...overrides,
  };
}

describe("cornerPoint", () => {
  const box = { x: 10, y: 20, width: 100, height: 50 };

  it("nw is the box's own x/y", () => {
    expect(cornerPoint("nw", box)).toEqual({ x: 10, y: 20 });
  });

  it("ne is x+width, y", () => {
    expect(cornerPoint("ne", box)).toEqual({ x: 110, y: 20 });
  });

  it("sw is x, y+height", () => {
    expect(cornerPoint("sw", box)).toEqual({ x: 10, y: 70 });
  });

  it("se is x+width, y+height", () => {
    expect(cornerPoint("se", box)).toEqual({ x: 110, y: 70 });
  });
});

describe("OPPOSITE_CORNER", () => {
  it("maps each corner to its diagonal opposite", () => {
    expect(OPPOSITE_CORNER).toEqual({ nw: "se", ne: "sw", sw: "ne", se: "nw" });
  });

  it("is its own inverse — applying it twice returns the original corner", () => {
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      expect(OPPOSITE_CORNER[OPPOSITE_CORNER[corner]]).toBe(corner);
    }
  });
});

describe("rectsIntersect", () => {
  it("overlapping rects intersect", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
  });

  it("one rect fully containing another intersects", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 5, height: 5 })).toBe(true);
  });

  it("rects separated on the x axis do not intersect", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it("rects separated on the y axis do not intersect", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it("rects that only touch at an edge do not intersect (strict bounding-box overlap, not closed-interval)", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe("subtreeForcesUniformScale", () => {
  it("text/circle/path/table elements force uniform scale directly", () => {
    for (const kind of ["text", "circle", "path", "table"] as const) {
      expect(subtreeForcesUniformScale(element({ kind }))).toBe(true);
    }
  });

  it("rect/ellipse/line/image elements do not force uniform scale", () => {
    for (const kind of ["rect", "ellipse", "line", "image"] as const) {
      expect(subtreeForcesUniformScale(element({ kind }))).toBe(false);
    }
  });

  it("a compound element forces uniform scale only when one of its primitives is text/circle/path", () => {
    const withText = element({
      kind: "compound",
      primitives: [
        { tag: "rect", attrs: new Map(), text: "", tspanCount: 0, runs: [] },
        { tag: "text", attrs: new Map(), text: "hello", tspanCount: 1, runs: [] },
      ],
    });
    const withoutForcingPrimitive = element({
      kind: "compound",
      primitives: [
        { tag: "rect", attrs: new Map(), text: "", tspanCount: 0, runs: [] },
        { tag: "line", attrs: new Map(), text: "", tspanCount: 0, runs: [] },
      ],
    });
    expect(subtreeForcesUniformScale(withText)).toBe(true);
    expect(subtreeForcesUniformScale(withoutForcingPrimitive)).toBe(false);
  });

  it("a group forces uniform scale when any descendant does, recursively", () => {
    const groupWithForcingChild = element({
      kind: "group",
      children: [element({ id: "child-1", kind: "rect" }), element({ id: "child-2", kind: "circle" })],
    });
    const groupWithoutForcingChild = element({
      kind: "group",
      children: [element({ id: "child-1", kind: "rect" }), element({ id: "child-2", kind: "image" })],
    });
    expect(subtreeForcesUniformScale(groupWithForcingChild)).toBe(true);
    expect(subtreeForcesUniformScale(groupWithoutForcingChild)).toBe(false);
  });

  it("a nested group forces uniform scale when a deeply-nested descendant does", () => {
    const nested = element({
      kind: "group",
      children: [
        element({
          id: "inner-group",
          kind: "group",
          children: [element({ id: "leaf", kind: "path" })],
        }),
      ],
    });
    expect(subtreeForcesUniformScale(nested)).toBe(true);
  });
});
