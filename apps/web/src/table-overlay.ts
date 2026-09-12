/**
 * Pure geometry for the table cell-range overlay, the column-width drag
 * handles, and the cell editor's position (E2.T14, plan §4.5). All inputs
 * are already-converted client px (`table-cells` runtime response) or
 * well-relative px (`OverlayLayer.tsx`'s `toLocalRect`/`toLocalPoint`) —
 * this module does no unit conversion of its own, only range/rect math, so
 * it can be unit-tested with plain numbers.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CellAddress {
  row: number;
  col: number;
}

export interface TableCellRect extends CellAddress {
  rect: Rect;
}

/** A rectangular cell range, always normalised so `r0<=r1` and `c0<=c1` (plan §4.5: "範圍一律正規化成 r0<=r1, c0<=c1"). */
export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** Builds a normalised range from an anchor cell (where ⇧-click/drag started) and the current cell. */
export function normalizeRange(anchor: CellAddress, current: CellAddress): CellRange {
  return {
    r0: Math.min(anchor.row, current.row),
    r1: Math.max(anchor.row, current.row),
    c0: Math.min(anchor.col, current.col),
    c1: Math.max(anchor.col, current.col),
  };
}

/** Every cell address a range covers, row-major. */
export function cellsInRange(range: CellRange): CellAddress[] {
  const cells: CellAddress[] = [];
  for (let row = range.r0; row <= range.r1; row++) {
    for (let col = range.c0; col <= range.c1; col++) {
      cells.push({ row, col });
    }
  }
  return cells;
}

export function isCellInRange(cell: CellAddress, range: CellRange): boolean {
  return cell.row >= range.r0 && cell.row <= range.r1 && cell.col >= range.c0 && cell.col <= range.c1;
}

/** The single rect for a cell address, or `null` when the runtime never reported one (e.g. covered by a merge). */
export function cellRectAt(cellRects: readonly TableCellRect[], cell: CellAddress): Rect | null {
  return cellRects.find((entry) => entry.row === cell.row && entry.col === cell.col)?.rect ?? null;
}

/**
 * The bounding rect of every reported cell whose address falls inside
 * `range` — the range-highlight overlay's own rect. `null` when no
 * reported cell falls inside the range (e.g. the runtime hasn't reported
 * yet).
 */
export function rangeBoundingRect(cellRects: readonly TableCellRect[], range: CellRange): Rect | null {
  const matching = cellRects.filter((entry) => isCellInRange(entry, range));
  if (matching.length === 0) return null;
  const left = Math.min(...matching.map((entry) => entry.rect.x));
  const top = Math.min(...matching.map((entry) => entry.rect.y));
  const right = Math.max(...matching.map((entry) => entry.rect.x + entry.rect.width));
  const bottom = Math.max(...matching.map((entry) => entry.rect.y + entry.rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Tab/⇧Tab's next cell (plan §4.5: row-major order, wraps to the next row,
 * stops in place at the very last/first cell rather than adding a row).
 * Assumes a uniform `rowCount × colCount` grid — a merged cell's covered
 * positions are simply skipped over silently by the caller re-resolving
 * against `cellRectAt` (a covered position never has its own rect).
 */
export function tabTarget(current: CellAddress, rowCount: number, colCount: number, direction: 1 | -1): CellAddress {
  const maxIndex = rowCount * colCount - 1;
  const index = Math.max(0, Math.min(maxIndex, current.row * colCount + current.col + direction));
  return { row: Math.floor(index / colCount), col: index % colCount };
}

/**
 * Column-boundary drag-handle x positions (client px, relative to the
 * table's own box left edge), one per boundary between adjacent columns
 * plus the trailing edge — `col`'s handle is the boundary between column
 * `col` and `col+1`. `previewColumn` overrides one column's width for the
 * live-drag preview (plan §4.5 "拖曳期間只即時移動格線"), leaving every
 * other column's contribution unchanged.
 */
/** Mirrors `packages/core/src/table/layout.ts`'s MIN_COL_WIDTH (the web bundle no longer depends on core at all, F8/NOOP-289): the narrowest a boundary drag may squeeze either column to. */
export const MIN_COL_WIDTH = 40;

export function columnBoundaryPositions(
  boxLeft: number,
  colWidths: readonly number[],
  previewColumn?: { col: number; width: number },
): number[] {
  const positions: number[] = [];
  let x = boxLeft;
  colWidths.forEach((width, index) => {
    const effectiveWidth = previewColumn && previewColumn.col === index ? previewColumn.width : width;
    x += effectiveWidth;
    positions.push(x);
  });
  return positions;
}

/** The cell editor `<input>`'s position/size — exactly the target cell's own reported rect, no adjustment. */
export function editorRectForCell(cellRects: readonly TableCellRect[], cell: CellAddress): Rect | null {
  return cellRectAt(cellRects, cell);
}

/** The address-plus-flags shape `nextTableTabCell`/`templateRowForColumn` need from a `TableModel`'s `cells` (F-09, NOOP-399) — deliberately narrower than the full `TableCell`, so this module still takes no dependency on `slide-dom.ts`. */
export interface TabbableCell extends CellAddress {
  repeat: boolean;
  generated: boolean;
}

/** The template row's own row index for `col` — the `repeat` cell sharing that column, or `null` when none exists. Mirrors selection-runtime.js's `findTemplateCellForColumn` (架構: "雙擊編輯的是模板列"), so a Tab-in-editing landing on a generated cell resolves the same write target a double-click on it would. */
export function templateRowForColumn(cells: readonly TabbableCell[], col: number): number | null {
  return cells.find((cell) => cell.col === col && cell.repeat)?.row ?? null;
}

/**
 * Tab/⇧Tab's next cell while a table cell is being edited (F-09, NOOP-399,
 * plan §4/§7.2) — navigates OWN (display) addresses via `tabTarget`,
 * re-resolving each candidate against `cells` (never rects, never
 * `rowSpan`/`colSpan` arithmetic — plan §7.5) and skipping any address with
 * no cell of its own (a merge's covered interior) or whose cell is a
 * hidden template row (`repeat`). The loop always terminates: `tabTarget`
 * clamps at the grid's edges, so once advancing stops changing the address
 * this returns `null` — "stay put", the same "原地不動、不加列" contract
 * `tabTarget` itself already has, now surfaced through the skip loop too.
 * The returned `row` is the WRITE address: for an ordinary cell that is
 * its own row, but for a `generated` cell it is the template row sharing
 * its column (same remap `postTableCellDblclick` applies on double-click),
 * since a generated cell's own row is not directly editable.
 */
export function nextTableTabCell(
  cells: readonly TabbableCell[],
  current: CellAddress,
  rowCount: number,
  colCount: number,
  direction: 1 | -1,
): { row: number; col: number; atRow: number } | null {
  let address: CellAddress = current;
  for (;;) {
    const next = tabTarget(address, rowCount, colCount, direction);
    if (next.row === address.row && next.col === address.col) return null;
    address = next;
    const cell = cells.find((entry) => entry.row === address.row && entry.col === address.col);
    if (!cell || cell.repeat) continue;
    const row = cell.generated ? (templateRowForColumn(cells, cell.col) ?? cell.row) : cell.row;
    return { row, col: cell.col, atRow: cell.row };
  }
}
