import { describe, expect, it } from "vitest";
import {
  cellRectAt,
  cellsInRange,
  columnBoundaryPositions,
  isCellInRange,
  nextTableTabCell,
  normalizeRange,
  rangeBoundingRect,
  tabTarget,
  templateRowForColumn,
  type TabbableCell,
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

describe("nextTableTabCell / templateRowForColumn (F-09: Tab while editing a cell)", () => {
  function cell(row: number, col: number, extra: Partial<TabbableCell> = {}): TabbableCell {
    return { row, col, repeat: false, generated: false, ...extra };
  }

  it("skips over a merge-covered position (with no cell entry of its own) and keeps advancing", () => {
    // 2x3 grid, (0,0) horizontally merges over (0,1) — (0,1) has no cell entry of its own.
    const cells = [cell(0, 0), cell(0, 2), cell(1, 0), cell(1, 1), cell(1, 2)];
    expect(nextTableTabCell(cells, { row: 0, col: 0 }, 2, 3, 1)).toEqual({ row: 0, col: 2, atRow: 0 });
  });

  it("skips over a template row (repeat === true) and keeps advancing", () => {
    // 3 rows x 1 col: the middle row is the hidden template row.
    const cells = [cell(0, 0), cell(1, 0, { repeat: true }), cell(2, 0)];
    expect(nextTableTabCell(cells, { row: 0, col: 0 }, 3, 1, 1)).toEqual({ row: 2, col: 0, atRow: 2 });
  });

  it("when the target cell is generated, the write address takes the template row for that column, and atRow is the target cell's own on-screen row", () => {
    const cells = [cell(0, 0, { repeat: true }), cell(0, 1, { repeat: true }), cell(1, 0, { generated: true }), cell(1, 1, { generated: true })];
    expect(nextTableTabCell(cells, { row: 1, col: 0 }, 2, 2, 1)).toEqual({ row: 0, col: 1, atRow: 1 });
    expect(templateRowForColumn(cells, 1)).toBe(0);
  });

  it("Tab on the last cell / Shift+Tab on the first cell: stays put (returns null), no row added, no leaving edit mode", () => {
    const cells = [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)];
    expect(nextTableTabCell(cells, { row: 1, col: 1 }, 2, 2, 1)).toBeNull();
    expect(nextTableTabCell(cells, { row: 0, col: 0 }, 2, 2, -1)).toBeNull();
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
