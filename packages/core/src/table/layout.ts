import { resolveFont } from "../element-text.js";
import { wrapText, type WrappedText } from "../text/wrap.js";
import type { FontMetrics } from "../text-metrics.js";
import { DEFAULT_FONT_FAMILY } from "../default-font.js";
import type { TableCell, TableModel } from "./model.js";

/**
 * Pure layout: from a `TableModel`'s cols/cells to concrete row heights and
 * per-cell geometry (plan §4.1, 已定案 constants). No `node:` imports.
 * Row heights are always core-computed — never accepted from the caller
 * (決定 2) — so this is the one place that number is decided, for both a
 * fresh `table create` and every subsequent edit.
 */

export const CELL_PADDING_X = 12;
export const CELL_PADDING_Y = 8;
export const MIN_ROW_HEIGHT = 32;
export const DEFAULT_COL_WIDTH = 160;
export const BODY_FONT_SIZE = 20;
export const HEADER_FONT_SIZE = 16;
export const HEADER_FONT_WEIGHT = 700;
export const BODY_FONT_WEIGHT = 400;

export interface CellLayout {
  /** The source cell this geometry belongs to (`row`/`col` and every styling field come from here). */
  cell: TableCell;
  /** Top-left corner, relative to the table container's own origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  wrapped: WrappedText;
}

export interface TableLayout {
  /** Computed row heights — a hidden template row's height is 0 (it must not push generated rows down). */
  rows: number[];
  cells: CellLayout[];
}

function fontSizeFor(row: number, header: boolean): number {
  return row === 0 && header ? HEADER_FONT_SIZE : BODY_FONT_SIZE;
}

/**
 * Computes every row's height and every cell's geometry + wrapped text.
 * `fonts` must carry `DEFAULT_FONT_FAMILY` — a table cell always uses the
 * presentation's default embedded font (no per-cell font-family, plan
 * scope).
 */
export function computeTableLayout(model: TableModel, fonts: ReadonlyMap<string, FontMetrics>): TableLayout {
  const font = resolveFont(fonts, DEFAULT_FONT_FAMILY, "table");

  const rowHeights = model.rows.map((_, row) => {
    const isTemplateRow = model.cells.some((cell) => cell.row === row && cell.repeat);
    if (isTemplateRow) return 0;

    const singleRowCells = model.cells.filter((cell) => cell.row === row && cell.rowSpan === 1);
    let tallest = MIN_ROW_HEIGHT;
    for (const cell of singleRowCells) {
      const width = sumRange(model.cols, cell.col, cell.colSpan) - 2 * CELL_PADDING_X;
      const fontSize = fontSizeFor(row, model.header);
      const wrapped = wrapText(cell.text, { width: Math.max(width, 1), font, fontSizePx: fontSize, align: cell.align });
      tallest = Math.max(tallest, wrapped.height + 2 * CELL_PADDING_Y);
    }
    return tallest;
  });

  const colOffsets = cumulativeOffsets(model.cols);
  const rowOffsets = cumulativeOffsets(rowHeights);

  const cells: CellLayout[] = model.cells.map((cell) => {
    const width = sumRange(model.cols, cell.col, cell.colSpan);
    const height = sumRange(rowHeights, cell.row, cell.rowSpan);
    const fontSize = fontSizeFor(cell.row, model.header);
    const usableWidth = Math.max(width - 2 * CELL_PADDING_X, 1);
    const wrapped = wrapText(cell.text, { width: usableWidth, font, fontSizePx: fontSize, align: cell.align });
    return {
      cell,
      x: colOffsets[cell.col],
      y: rowOffsets[cell.row],
      width,
      height,
      fontSize,
      wrapped,
    };
  });

  return { rows: rowHeights, cells };
}

function sumRange(values: readonly number[], start: number, count: number): number {
  let total = 0;
  for (let i = start; i < start + count; i++) total += values[i];
  return total;
}

function cumulativeOffsets(values: readonly number[]): number[] {
  const offsets: number[] = [];
  let total = 0;
  for (const value of values) {
    offsets.push(total);
    total += value;
  }
  return offsets;
}
