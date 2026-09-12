import { describe, expect, it } from "vitest";
import { classifyClipboardText } from "../src/clipboard/payload.js";
import { copyCommandFor, cutCommandFor, pasteCommandFor, type ClipboardTarget } from "../src/clipboard/dispatch.js";

// F8 (NOOP-289 決定 C1): recognition is now a shallow DOMParser check on the
// root `<svg>`'s own marker attribute (`data-slidra-clipboard="elements"`) —
// this literal is the same shape core's `serializeClipboardSvg`
// writes (element-clipboard.ts), inlined rather than generated, since the
// web bundle no longer depends on core at all.
const elementsSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:slidra="https://slidra.app/ns/2026" viewBox="0 0 1280 720" ' +
  'data-slidra-clipboard="elements" data-slidra-source="slides/001.svg">' +
  '<g id="el-a"><rect width="10" height="10"/></g></svg>';

describe("classifyClipboardText", () => {
  it("classifies null/undefined/empty/whitespace-only as empty", () => {
    expect(classifyClipboardText(null)).toEqual({ kind: "empty" });
    expect(classifyClipboardText(undefined)).toEqual({ kind: "empty" });
    expect(classifyClipboardText("")).toEqual({ kind: "empty" });
    expect(classifyClipboardText("   \n\t")).toEqual({ kind: "empty" });
  });

  it("classifies a slidra clipboard SVG as slidra-elements", () => {
    expect(classifyClipboardText(elementsSvg)).toEqual({ kind: "slidra-elements", svg: elementsSvg });
  });

  it("classifies plain text and foreign SVG (no clipboard marker) as plain", () => {
    expect(classifyClipboardText("hello")).toEqual({ kind: "plain", text: "hello" });
    expect(classifyClipboardText('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toEqual({
      kind: "plain",
      text: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    });
  });
});

describe("copyCommandFor / cutCommandFor", () => {
  it("null target (nothing selected) is a no-op for both", () => {
    expect(copyCommandFor(null)).toBeNull();
    expect(cutCommandFor(null)).toBeNull();
  });

  it("an elements target routes to element copy/cut", () => {
    const target: ClipboardTarget = { kind: "elements", slidePath: "slides/001.svg", elementIds: ["el-a", "el-b"] };
    expect(copyCommandFor(target)).toEqual({
      name: "element copy",
      input: { slidePath: "slides/001.svg", elementIds: ["el-a", "el-b"] },
    });
    expect(cutCommandFor(target)).toEqual({
      name: "element cut",
      input: { slidePath: "slides/001.svg", elementIds: ["el-a", "el-b"] },
    });
  });

  it("a cells target routes to table cell copy/cut with a normalised --range flag", () => {
    const target: ClipboardTarget = {
      kind: "cells",
      slidePath: "slides/001.svg",
      range: { tableElementId: "tbl-1", top: 0, left: 1, bottom: 2, right: 3 },
    };
    expect(copyCommandFor(target)).toEqual({
      name: "table cell copy",
      input: { slidePath: "slides/001.svg", elementId: "tbl-1", range: "0,1:2,3" },
    });
    expect(cutCommandFor(target)).toEqual({
      name: "table cell cut",
      input: { slidePath: "slides/001.svg", elementId: "tbl-1", range: "0,1:2,3" },
    });
  });
});

describe("pasteCommandFor", () => {
  it("empty clipboard text is always a no-op, regardless of selection", () => {
    expect(pasteCommandFor(null, { kind: "empty" }, "slides/001.svg", { dx: 0, dy: 0 })).toBeNull();
    const cellsTarget: ClipboardTarget = {
      kind: "cells",
      slidePath: "slides/001.svg",
      range: { tableElementId: "tbl-1", top: 0, left: 0, bottom: 0, right: 0 },
    };
    expect(pasteCommandFor(cellsTarget, { kind: "empty" }, "slides/001.svg", { dx: 0, dy: 0 })).toBeNull();
  });

  it("a slidra elements payload always routes to element paste, even with a cell range selected", () => {
    const cellsTarget: ClipboardTarget = {
      kind: "cells",
      slidePath: "slides/001.svg",
      range: { tableElementId: "tbl-1", top: 0, left: 0, bottom: 0, right: 0 },
    };
    const result = pasteCommandFor(cellsTarget, { kind: "slidra-elements", svg: elementsSvg }, "slides/002.svg", { dx: 20, dy: 20 });
    expect(result).toEqual({
      name: "element paste",
      input: { slidePath: "slides/002.svg", svg: elementsSvg, dx: 20, dy: 20 },
    });
  });

  it("plain text with a cell range selected routes to table cell paste, anchored at the range's top-left", () => {
    const cellsTarget: ClipboardTarget = {
      kind: "cells",
      slidePath: "slides/001.svg",
      range: { tableElementId: "tbl-1", top: 2, left: 1, bottom: 2, right: 1 },
    };
    const result = pasteCommandFor(cellsTarget, { kind: "plain", text: "a\tb" }, "slides/001.svg", { dx: 0, dy: 0 });
    expect(result).toEqual({
      name: "table cell paste",
      input: { slidePath: "slides/001.svg", elementId: "tbl-1", at: "2,1", tsv: "a\tb" },
    });
  });

  it("plain text with no cell range selected is a silent no-op — never creates a text box", () => {
    expect(pasteCommandFor(null, { kind: "plain", text: "hello" }, "slides/001.svg", { dx: 0, dy: 0 })).toBeNull();
    const elementsTarget: ClipboardTarget = { kind: "elements", slidePath: "slides/001.svg", elementIds: ["el-a"] };
    expect(pasteCommandFor(elementsTarget, { kind: "plain", text: "hello" }, "slides/001.svg", { dx: 0, dy: 0 })).toBeNull();
  });
});
