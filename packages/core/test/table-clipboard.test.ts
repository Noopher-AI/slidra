import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  copyTableCellRange,
  cutTableCellRange,
  parseCellAnchor,
  parseCellRange,
  pasteTableCellRange,
} from "../src/table-clipboard.js";

/** A 2x3 table (rows 0-1, cols 0-2), each cell a `<g data-comot-cell="r,c">` wrapping one `<text>`. */
function tableSlide(cellText: Record<string, string> = {}): string {
  const cells: string[] = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const text = cellText[`${r},${c}`] ?? `r${r}c${c}`;
      cells.push(`<g id="cell-${r}-${c}" data-comot-cell="${r},${c}"><text x="0" y="0">${text}</text></g>`);
    }
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
    `<g id="tbl-1" data-comot-type="table">${cells.join("")}</g>` +
    "</svg>"
  );
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
    const svg = tableSlide();
    const tsv = copyTableCellRange(svg, "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 1, right: 2 });
    expect(tsv).toBe("r0c0\tr0c1\tr0c2\nr1c0\tr1c1\tr1c2");
  });

  it("reads a single-cell range", () => {
    const svg = tableSlide();
    const tsv = copyTableCellRange(svg, "slides/001.svg", "tbl-1", { top: 1, left: 1, bottom: 1, right: 1 });
    expect(tsv).toBe("r1c1");
  });

  it("throws when the range exceeds the table's actual size, naming the size", () => {
    const svg = tableSlide();
    expect(() => copyTableCellRange(svg, "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 5, right: 5 })).toThrow(
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
    const svg = tableSlide();
    const { tsv, updated } = cutTableCellRange(svg, "slides/001.svg", "tbl-1", { top: 0, left: 0, bottom: 0, right: 1 });
    expect(tsv).toBe("r0c0\tr0c1");
    expect(updated).toContain('<g id="cell-0-0" data-comot-cell="0,0"><text x="0" y="0"></text></g>');
    expect(updated).toContain('<g id="cell-0-1" data-comot-cell="0,1"><text x="0" y="0"></text></g>');
    // Untouched cell keeps its text and its own <g> is unchanged.
    expect(updated).toContain('<g id="cell-0-2" data-comot-cell="0,2"><text x="0" y="0">r0c2</text></g>');
  });
});

describe("pasteTableCellRange", () => {
  it("writes TSV cells starting at the anchor, XML-escaped", () => {
    const svg = tableSlide();
    const { updated, cells } = pasteTableCellRange(svg, "slides/001.svg", "tbl-1", { row: 0, col: 0 }, "a<b\tc&d");
    expect(cells).toBe(2);
    expect(updated).toContain('<text x="0" y="0">a&lt;b</text>');
    expect(updated).toContain('<text x="0" y="0">c&amp;d</text>');
  });

  it("clips a TSV larger than the remaining table space, reporting the actual count written", () => {
    const svg = tableSlide();
    const tsv = "a\tb\tc\td\ne\tf\tg\th"; // 2 rows x 4 cols, table only has 3 cols from anchor 0,0
    const { updated, cells } = pasteTableCellRange(svg, "slides/001.svg", "tbl-1", { row: 0, col: 0 }, tsv);
    expect(cells).toBe(6); // 2 rows x 3 cols (clipped)
    expect(updated).toContain('<g id="cell-0-0" data-comot-cell="0,0"><text x="0" y="0">a</text></g>');
    expect(updated).toContain('<g id="cell-0-2" data-comot-cell="0,2"><text x="0" y="0">c</text></g>');
    expect(updated).toContain('<g id="cell-1-2" data-comot-cell="1,2"><text x="0" y="0">g</text></g>');
  });

  it("pads a ragged (short) row with empty cells up to the TSV's own widest row", () => {
    const svg = tableSlide();
    const tsv = "a\tb\tc\nd"; // second row only has one cell, but the TSV's widest row is 3
    const { updated } = pasteTableCellRange(svg, "slides/001.svg", "tbl-1", { row: 0, col: 0 }, tsv);
    expect(updated).toContain('<g id="cell-1-0" data-comot-cell="1,0"><text x="0" y="0">d</text></g>');
    expect(updated).toContain('<g id="cell-1-1" data-comot-cell="1,1"><text x="0" y="0"></text></g>');
    expect(updated).toContain('<g id="cell-1-2" data-comot-cell="1,2"><text x="0" y="0"></text></g>');
  });

  it("rejects an empty TSV, leaving the table unchanged", () => {
    const svg = tableSlide();
    expect(() => pasteTableCellRange(svg, "slides/001.svg", "tbl-1", { row: 0, col: 0 }, "")).toThrow(/沒有可貼上的內容/);
  });

  it("rejects an anchor outside the table's actual size", () => {
    const svg = tableSlide();
    expect(() => pasteTableCellRange(svg, "slides/001.svg", "tbl-1", { row: 9, col: 9 }, "x")).toThrow(/2 列 3 欄/);
  });

  it("writes starting at a non-zero anchor, not from the table's own origin", () => {
    const svg = tableSlide();
    const { updated, cells } = pasteTableCellRange(svg, "slides/001.svg", "tbl-1", { row: 1, col: 1 }, "x\ty");
    expect(cells).toBe(2);
    expect(updated).toContain('<g id="cell-1-1" data-comot-cell="1,1"><text x="0" y="0">x</text></g>');
    expect(updated).toContain('<g id="cell-1-2" data-comot-cell="1,2"><text x="0" y="0">y</text></g>');
    // Cells outside the anchor's span are untouched, including row 0 — a naive `r = i` mistake would land here instead.
    expect(updated).toContain('<g id="cell-0-0" data-comot-cell="0,0"><text x="0" y="0">r0c0</text></g>');
    expect(updated).toContain('<g id="cell-0-1" data-comot-cell="0,1"><text x="0" y="0">r0c1</text></g>');
  });
});
