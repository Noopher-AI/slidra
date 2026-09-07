import { CoMotionError } from "./errors.js";
import { assertSlideCompliant } from "./slide/format.js";
import { readTableModel, type TableCell, type TableModel } from "./table/model.js";
import { setTableCellTexts } from "./table/edit.js";
import type { FontMetrics } from "./text-metrics.js";

/**
 * `table cell copy / cut / paste` ([E2.T18] 計畫 §6) on top of [E2.T14]/#203's
 * table container: reads go through `readTableModel` (which reassembles a
 * cell's `<tspan>`s back into plain text), writes go through
 * `setTableCellTexts` (which re-derives and re-renders the whole container,
 * the same way every other `table` command writes — the clipboard never
 * splices `<text>` content by hand). Kept as its own file so the cell-range
 * exchange format (TSV) stays out of `core/src/table/**`'s model/edit code.
 */

export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface CellAnchor {
  row: number;
  col: number;
}

const RANGE_PATTERN = /^(\d+),(\d+):(\d+),(\d+)$/;

/** Parses `--range r,c:r,c` (CLI's `table cell copy/cut`). A reversed range (`3,3:1,1`) is legal and gets normalised, not rejected. */
export function parseCellRange(raw: string): CellRange {
  const match = RANGE_PATTERN.exec(raw.trim());
  if (!match) {
    throw new CoMotionError(`--range 格式錯誤，必須是 r,c:r,c（非負整數）：${raw}`);
  }
  const [r1, c1, r2, c2] = match.slice(1).map(Number);
  return { top: Math.min(r1, r2), left: Math.min(c1, c2), bottom: Math.max(r1, r2), right: Math.max(c1, c2) };
}

const ANCHOR_PATTERN = /^(\d+),(\d+)$/;

/** Parses `--at r,c` (CLI's `table cell paste`). */
export function parseCellAnchor(raw: string): CellAnchor {
  const match = ANCHOR_PATTERN.exec(raw.trim());
  if (!match) {
    throw new CoMotionError(`--at 格式錯誤，必須是 r,c（非負整數）：${raw}`);
  }
  return { row: Number(match[1]), col: Number(match[2]) };
}

function cellAt(model: TableModel, row: number, col: number): TableCell | undefined {
  return model.cells.find((cell) => cell.row === row && cell.col === col);
}

function requireRangeWithinBounds(range: CellRange, model: TableModel): void {
  const rows = model.rows.length;
  const cols = model.cols.length;
  if (range.bottom >= rows || range.right >= cols) {
    throw new CoMotionError(`--range 超出表格實際列／欄數（表格為 ${rows} 列 ${cols} 欄）`);
  }
}

/** `table cell copy` (CLI) — reads `range` into a TSV string. Never mutates `svgContent`. A span-covered position reads as an empty cell. */
export function copyTableCellRange(svgContent: string, slidePath: string, tableElementId: string, range: CellRange): string {
  assertSlideCompliant(svgContent, slidePath);
  const model = readTableModel(svgContent, tableElementId);
  requireRangeWithinBounds(range, model);

  const lines: string[] = [];
  for (let r = range.top; r <= range.bottom; r++) {
    const rowValues: string[] = [];
    for (let c = range.left; c <= range.right; c++) {
      rowValues.push(cellAt(model, r, c)?.text ?? "");
    }
    lines.push(rowValues.join("\t"));
  }
  return lines.join("\n");
}

/** `table cell cut` (CLI) — same read as `copyTableCellRange`, then clears every cell in `range` (text only; the cell and its styling stay). One `writePresentationFile` call by the caller = one undo step. */
export function cutTableCellRange(
  svgContent: string,
  slidePath: string,
  tableElementId: string,
  range: CellRange,
  fonts: ReadonlyMap<string, FontMetrics>,
): { tsv: string; updated: string } {
  const tsv = copyTableCellRange(svgContent, slidePath, tableElementId, range);
  const model = readTableModel(svgContent, tableElementId);

  const entries: { row: number; col: number; text: string }[] = [];
  for (let r = range.top; r <= range.bottom; r++) {
    for (let c = range.left; c <= range.right; c++) {
      if (cellAt(model, r, c)) entries.push({ row: r, col: c, text: "" });
    }
  }
  const updated = entries.length === 0 ? svgContent : setTableCellTexts(svgContent, slidePath, tableElementId, entries, fonts);
  return { tsv, updated };
}

/**
 * `table cell paste` (CLI) — writes `tsv` starting at `anchor`, clipped to
 * the table's actual bounds (never expands the table). Ragged rows are
 * legal: a short row is padded with empty cells up to the TSV's own widest
 * row, not left with whatever text the target cell already had.
 */
export function pasteTableCellRange(
  svgContent: string,
  slidePath: string,
  tableElementId: string,
  anchor: CellAnchor,
  tsv: string,
  fonts: ReadonlyMap<string, FontMetrics>,
): { updated: string; cells: number } {
  assertSlideCompliant(svgContent, slidePath);
  if (tsv.length === 0) {
    throw new CoMotionError("沒有可貼上的內容");
  }
  if (!Number.isInteger(anchor.row) || !Number.isInteger(anchor.col) || anchor.row < 0 || anchor.col < 0) {
    throw new CoMotionError(`--at 必須是非負整數座標：${anchor.row},${anchor.col}`);
  }

  const model = readTableModel(svgContent, tableElementId);
  const rows = model.rows.length;
  const cols = model.cols.length;
  if (anchor.row >= rows || anchor.col >= cols) {
    throw new CoMotionError(`--at 超出表格實際列／欄數（表格為 ${rows} 列 ${cols} 欄）`);
  }

  const tsvRows = tsv.split("\n").map((line) => line.split("\t"));
  const tsvWidth = Math.max(...tsvRows.map((row) => row.length));
  const rowSpan = Math.min(tsvRows.length, rows - anchor.row);
  const colSpan = Math.min(tsvWidth, cols - anchor.col);

  const entries: { row: number; col: number; text: string }[] = [];
  for (let i = 0; i < rowSpan; i++) {
    for (let j = 0; j < colSpan; j++) {
      const r = anchor.row + i;
      const c = anchor.col + j;
      if (!cellAt(model, r, c)) continue;
      entries.push({ row: r, col: c, text: tsvRows[i][j] ?? "" });
    }
  }
  const updated = entries.length === 0 ? svgContent : setTableCellTexts(svgContent, slidePath, tableElementId, entries, fonts);
  return { updated, cells: entries.length };
}
