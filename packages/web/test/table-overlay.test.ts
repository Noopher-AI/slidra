import { describe, expect, it } from "vitest";
import {
  cellRectAt,
  cellsInRange,
  columnBoundaryPositions,
  isCellInRange,
  normalizeRange,
  rangeBoundingRect,
  tabTarget,
  type TableCellRect,
} from "../src/table-overlay.js";

describe("normalizeRange / cellsInRange (plan §4.5)", () => {
  it("normalises regardless of drag direction", () => {
    expect(normalizeRange({ row: 2, col: 2 }, { row: 0, col: 0 })).toEqual({ r0: 0, c0: 0, r1: 2, c1: 2 });
    expect(normalizeRange({ row: 0, col: 0 }, { row: 2, col: 2 })).toEqual({ r0: 0, c0: 0, r1: 2, c1: 2 });
  });

  it("a single-cell range enumerates exactly one cell", () => {
    expect(cellsInRange({ r0: 1, c0: 1, r1: 1, c1: 1 })).toEqual([{ row: 1, col: 1 }]);
  });

  it("a 2x2 range enumerates four cells in row-major order", () => {
    expect(cellsInRange({ r0: 0, c0: 0, r1: 1, c1: 1 })).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ]);
  });

  it("isCellInRange", () => {
    const range = { r0: 0, c0: 0, r1: 1, c1: 1 };
    expect(isCellInRange({ row: 1, col: 1 }, range)).toBe(true);
    expect(isCellInRange({ row: 2, col: 0 }, range)).toBe(false);
  });
});

describe("rangeBoundingRect / cellRectAt", () => {
  const cells: TableCellRect[] = [
    { row: 0, col: 0, rect: { x: 0, y: 0, width: 100, height: 40 } },
    { row: 0, col: 1, rect: { x: 100, y: 0, width: 100, height: 40 } },
    { row: 1, col: 0, rect: { x: 0, y: 40, width: 100, height: 40 } },
    { row: 1, col: 1, rect: { x: 100, y: 40, width: 100, height: 40 } },
  ];

  it("a single-cell range's bounding rect equals that cell's rect", () => {
    expect(rangeBoundingRect(cells, { r0: 0, c0: 0, r1: 0, c1: 0 })).toEqual({ x: 0, y: 0, width: 100, height: 40 });
  });

  it("a 2x2 range's bounding rect covers all four cells", () => {
    expect(rangeBoundingRect(cells, { r0: 0, c0: 0, r1: 1, c1: 1 })).toEqual({ x: 0, y: 0, width: 200, height: 80 });
  });

  it("returns null when no reported cell falls inside the range", () => {
    expect(rangeBoundingRect(cells, { r0: 5, c0: 5, r1: 5, c1: 5 })).toBeNull();
  });

  it("cellRectAt returns null for an address with no reported rect", () => {
    expect(cellRectAt(cells, { row: 9, col: 9 })).toBeNull();
  });
});

describe("tabTarget (plan §4.5: row-major, stops at the last/first cell)", () => {
  it("moves to the next cell in the same row", () => {
    expect(tabTarget({ row: 0, col: 0 }, 3, 3, 1)).toEqual({ row: 0, col: 1 });
  });

  it("wraps to the next row at the row's end", () => {
    expect(tabTarget({ row: 0, col: 2 }, 3, 3, 1)).toEqual({ row: 1, col: 0 });
  });

  it("stops in place at the very last cell — does not add a row", () => {
    expect(tabTarget({ row: 2, col: 2 }, 3, 3, 1)).toEqual({ row: 2, col: 2 });
  });

  it("⇧Tab moves backward and stops at the first cell", () => {
    expect(tabTarget({ row: 1, col: 0 }, 3, 3, -1)).toEqual({ row: 0, col: 2 });
    expect(tabTarget({ row: 0, col: 0 }, 3, 3, -1)).toEqual({ row: 0, col: 0 });
  });
});

describe("columnBoundaryPositions", () => {
  it("returns cumulative x offsets, one per column boundary", () => {
    expect(columnBoundaryPositions(100, [50, 100, 150])).toEqual([150, 250, 400]);
  });

  it("a preview override changes only that column's contribution, and every boundary after it", () => {
    expect(columnBoundaryPositions(100, [50, 100, 150], { col: 0, width: 80 })).toEqual([180, 280, 430]);
  });
});
