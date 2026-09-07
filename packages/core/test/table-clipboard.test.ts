import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { parseFont, type FontMetrics } from "../src/text-metrics.js";
import { createTableElement, setTableCellText } from "../src/table/edit.js";
import { readTableModel } from "../src/table/model.js";
import {
  copyTableCellRange,
  cutTableCellRange,
  parseCellAnchor,
  parseCellRange,
  pasteTableCellRange,
} from "../src/table-clipboard.js";

const bundledFontPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/assets/fonts/NotoSansTC-Presentation.ttf");
const BLANK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>';
let fonts: Map<string, FontMetrics>;

beforeAll(async () => {
  fonts = new Map([["Noto Sans TC", parseFont(new Uint8Array(await readFile(bundledFontPath)))]]);
});

/** A real [E2.T14] 2x3 table (rows 0-1, cols 0-2), each cell's text `r{r}c{c}` unless overridden. */
function tableSlide(cellText: Record<string, string> = {}): string {
  let svg = createTableElement(BLANK, "slides/001.svg", "tbl-1", { rows: 2, cols: 3, x: 100, y: 100 }, fonts);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      svg = setTableCellText(svg, "slides/001.svg", "tbl-1", r, c, cellText[`${r},${c}`] ?? `r${r}c${c}`, fonts);
    }
  }
  return svg;
}

function textAt(svg: string, row: number, col: number): string {
  return readTableModel(svg, "tbl-1").cells.find((cell) => cell.row === row && cell.col === col)!.text;
}

describe("parseCellRange", () => {
  it("parses a normal range", () => {
    expect(parseCellRange("0,0:1,2")).toEqual({ top: 0, left: 0, bottom: 1, right: 2 });
  });

  it("normalises a reversed range (start > end) instead of rejecting it", () => {
    expect(parseCellRange("3,3:1,1")).toEqual({ top: 1, left: 1, bottom: 3, right: 3 });
  });

  it("rejects a malformed range", () => {
    expect(() => parseCellRange("not-a-range")).toThrow(CoMotionError);
    expect(() => parseCellRange("-1,0:1,1")).toThrow(CoMotionError);
    expect(() => parseCellRange("0.5,0:1,1")).toThrow(CoMotionError);
  });
});

describe("parseCellAnchor", () => {
  it("parses a normal anchor", () => {
    expect(parseCellAnchor("1,2")).toEqual({ row: 1, col: 2 });
  });

  it("rejects a malformed anchor", () => {
    expect(() => parseCellAnchor("1")).toThrow(CoMotionError);
    expect(() => parseCellAnchor("-1,2")).toThrow(CoMotionError);
  });
});

describe("copyTableCellRange", () => {
  it("reads a rectangular range into TSV, row-major", () => {
    const tsv = copyTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 1, right: 2 });
    expect(tsv).toBe("r0c0\tr0c1\tr0c2\nr1c0\tr1c1\tr1c2");
  });

  it("reads a single-cell range", () => {
    const tsv = copyTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { top: 1, left: 1, bottom: 1, right: 1 });
    expect(tsv).toBe("r1c1");
  });

  it("reads a cell's text back as plain text, not its <tspan> markup", () => {
    const tsv = copyTableCellRange(tableSlide({ "0,0": "a<b & c" }), "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 0, right: 0 });
    expect(tsv).toBe("a<b & c");
  });

  it("throws when the range exceeds the table's actual size, naming the size", () => {
    expect(() => copyTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 5, right: 5 })).toThrow(
      /2 列 3 欄/,
    );
  });

  it("throws when the element is not a table container", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><g id="not-a-table"><rect width="1" height="1"/></g></svg>';
    expect(() => copyTableCellRange(svg, "slides/001.svg", "not-a-table", { top: 0, left: 0, bottom: 0, right: 0 })).toThrow(
      /不是表格/,
    );
  });

  it("never mutates the source", () => {
    const svg = tableSlide();
    copyTableCellRange(svg, "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 0, right: 0 });
    expect(tableSlide()).toBe(svg);
  });
});

describe("cutTableCellRange", () => {
  it("returns the same TSV copy would, and clears the range's text while keeping the cells", () => {
    const { tsv, updated } = cutTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 0, right: 1 }, fonts);
    expect(tsv).toBe("r0c0\tr0c1");
    expect(textAt(updated, 0, 0)).toBe("");
    expect(textAt(updated, 0, 1)).toBe("");
    expect(textAt(updated, 0, 2)).toBe("r0c2");
    expect(readTableModel(updated, "tbl-1").cells).toHaveLength(6);
  });
});

describe("pasteTableCellRange", () => {
  it("writes TSV cells starting at the anchor, XML-escaped", () => {
    const { updated, cells } = pasteTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { row: 0, col: 0 }, "a<b\tc&d", fonts);
    expect(cells).toBe(2);
    expect(updated).toContain("a&lt;b");
    expect(updated).toContain("c&amp;d");
    expect(textAt(updated, 0, 0)).toBe("a<b");
    expect(textAt(updated, 0, 1)).toBe("c&d");
  });

  it("clips a TSV larger than the remaining table space, reporting the actual count written", () => {
    const tsv = "a\tb\tc\td\ne\tf\tg\th"; // 2 rows x 4 cols, table only has 3 cols from anchor 0,0
    const { updated, cells } = pasteTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { row: 0, col: 0 }, tsv, fonts);
    expect(cells).toBe(6); // 2 rows x 3 cols (clipped)
    expect(textAt(updated, 0, 0)).toBe("a");
    expect(textAt(updated, 0, 2)).toBe("c");
    expect(textAt(updated, 1, 2)).toBe("g");
  });

  it("pads a ragged (short) row with empty cells up to the TSV's own widest row", () => {
    const tsv = "a\tb\tc\nd"; // second row only has one cell, but the TSV's widest row is 3
    const { updated } = pasteTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { row: 0, col: 0 }, tsv, fonts);
    expect(textAt(updated, 1, 0)).toBe("d");
    expect(textAt(updated, 1, 1)).toBe("");
    expect(textAt(updated, 1, 2)).toBe("");
  });

  it("rejects an empty TSV, leaving the table unchanged", () => {
    expect(() => pasteTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { row: 0, col: 0 }, "", fonts)).toThrow(/沒有可貼上的內容/);
  });

  it("rejects an anchor outside the table's actual size", () => {
    expect(() => pasteTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { row: 9, col: 9 }, "x", fonts)).toThrow(/2 列 3 欄/);
  });

  it("writes starting at a non-zero anchor, not from the table's own origin", () => {
    const { updated, cells } = pasteTableCellRange(tableSlide(), "slides/001.svg", "tbl-1", { row: 1, col: 1 }, "x\ty", fonts);
    expect(cells).toBe(2);
    expect(textAt(updated, 1, 1)).toBe("x");
    expect(textAt(updated, 1, 2)).toBe("y");
    // Cells outside the anchor's span are untouched, including row 0 — a naive `r = i` mistake would land here instead.
    expect(textAt(updated, 0, 0)).toBe("r0c0");
    expect(textAt(updated, 0, 1)).toBe("r0c1");
  });
});
