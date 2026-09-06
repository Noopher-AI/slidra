import { CoMotionError } from "./errors.js";
import { assertSlideCompliant } from "./slide/format.js";
import { attributeValue, scanDocument, type ScannedNode } from "./slide/scan.js";
import { escapeXmlText, unescapeXmlText } from "./element-text.js";

/**
 * `table cell copy / cut / paste` ([E2.T18] 計畫 §6, soft dependency on
 * [E2.T14]/#203's table container shape: `data-comot-type="table"` on the
 * table's own `<g>`, `data-comot-cell="r,c"` (0-based) on each cell `<g>`).
 * Deliberately its own file, not `core/src/table/**` — that directory
 * belongs to [E2.T14], and this ticket only needs the three cell-range
 * clipboard operations, not the rest of the table command family.
 *
 * A cell's text lives in its own `<text>` primitive child, written the same
 * way `element-text.ts` writes any other `<text>` content — this module
 * does not create a `<text>` a cell doesn't already have (no fallback: a
 * cell built without one is a [E2.T14] fixture bug, not something to paper
 * over here).
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

interface Splice {
  start: number;
  end: number;
  text: string;
}

function applySplices(svg: string, splices: readonly Splice[]): string {
  let result = svg;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
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

interface Cell {
  node: ScannedNode;
  row: number;
  col: number;
}

function findContainerById(node: ScannedNode, id: string): ScannedNode | undefined {
  for (const child of node.children) {
    if (child.tag !== "g") continue;
    if (attributeValue(child, "id") === id) return child;
    const found = findContainerById(child, id);
    if (found) return found;
  }
  return undefined;
}

function requireTableContainer(svgContent: string, tableElementId: string): ScannedNode {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  const table = findContainerById(svgRoot, tableElementId);
  if (!table) {
    throw new CoMotionError(`找不到元素：${tableElementId}`);
  }
  if (attributeValue(table, "data-comot-type") !== "table") {
    throw new CoMotionError(`元素 ${tableElementId} 不是表格`);
  }
  return table;
}

const CELL_ATTR_PATTERN = /^(\d+),(\d+)$/;

function collectCells(table: ScannedNode): Cell[] {
  const cells: Cell[] = [];
  for (const child of table.children) {
    if (child.tag !== "g") continue;
    const raw = attributeValue(child, "data-comot-cell");
    if (!raw) continue;
    const match = CELL_ATTR_PATTERN.exec(raw.trim());
    if (!match) continue;
    cells.push({ node: child, row: Number(match[1]), col: Number(match[2]) });
  }
  return cells;
}

/** The table's dimensions, derived from the highest row/col any cell actually occupies — [E2.T14]'s container shape carries no separate `data-comot-rows`/`-cols` attribute for this ticket to read instead. */
function tableDimensions(cells: readonly Cell[]): { rows: number; cols: number } {
  let maxRow = -1;
  let maxCol = -1;
  for (const cell of cells) {
    maxRow = Math.max(maxRow, cell.row);
    maxCol = Math.max(maxCol, cell.col);
  }
  return { rows: maxRow + 1, cols: maxCol + 1 };
}

function cellTextNode(cell: Cell): ScannedNode | undefined {
  return cell.node.children.find((child) => child.tag === "text");
}

function readCellText(svg: string, cell: Cell): string {
  const textNode = cellTextNode(cell);
  if (!textNode) return "";
  return unescapeXmlText(svg.slice(textNode.contentStart, textNode.contentEnd));
}

function indexCells(cells: readonly Cell[]): Map<string, Cell> {
  return new Map(cells.map((cell) => [`${cell.row},${cell.col}`, cell]));
}

function requireRangeWithinBounds(range: CellRange, rows: number, cols: number): void {
  if (range.bottom >= rows || range.right >= cols) {
    throw new CoMotionError(`--range 超出表格實際列／欄數（表格為 ${rows} 列 ${cols} 欄）`);
  }
}

/** `table cell copy` (CLI) — reads `range` into a TSV string. Never mutates `svgContent`. */
export function copyTableCellRange(svgContent: string, slidePath: string, tableElementId: string, range: CellRange): string {
  assertSlideCompliant(svgContent, slidePath);
  const table = requireTableContainer(svgContent, tableElementId);
  const cells = collectCells(table);
  const { rows, cols } = tableDimensions(cells);
  requireRangeWithinBounds(range, rows, cols);

  const byPosition = indexCells(cells);
  const lines: string[] = [];
  for (let r = range.top; r <= range.bottom; r++) {
    const rowValues: string[] = [];
    for (let c = range.left; c <= range.right; c++) {
      const cell = byPosition.get(`${r},${c}`);
      rowValues.push(cell ? readCellText(svgContent, cell) : "");
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
): { tsv: string; updated: string } {
  const tsv = copyTableCellRange(svgContent, slidePath, tableElementId, range);

  const table = requireTableContainer(svgContent, tableElementId);
  const cells = collectCells(table);
  const byPosition = indexCells(cells);
  const splices: Splice[] = [];
  for (let r = range.top; r <= range.bottom; r++) {
    for (let c = range.left; c <= range.right; c++) {
      const cell = byPosition.get(`${r},${c}`);
      if (!cell) continue;
      const textNode = cellTextNode(cell);
      if (!textNode) continue;
      splices.push({ start: textNode.contentStart, end: textNode.contentEnd, text: "" });
    }
  }
  return { tsv, updated: applySplices(svgContent, splices) };
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
): { updated: string; cells: number } {
  assertSlideCompliant(svgContent, slidePath);
  if (tsv.length === 0) {
    throw new CoMotionError("沒有可貼上的內容");
  }
  if (!Number.isInteger(anchor.row) || !Number.isInteger(anchor.col) || anchor.row < 0 || anchor.col < 0) {
    throw new CoMotionError(`--at 必須是非負整數座標：${anchor.row},${anchor.col}`);
  }

  const table = requireTableContainer(svgContent, tableElementId);
  const cells = collectCells(table);
  const { rows, cols } = tableDimensions(cells);
  if (anchor.row >= rows || anchor.col >= cols) {
    throw new CoMotionError(`--at 超出表格實際列／欄數（表格為 ${rows} 列 ${cols} 欄）`);
  }
  const byPosition = indexCells(cells);

  const tsvRows = tsv.split("\n").map((line) => line.split("\t"));
  const tsvWidth = Math.max(...tsvRows.map((row) => row.length));
  const rowSpan = Math.min(tsvRows.length, rows - anchor.row);
  const colSpan = Math.min(tsvWidth, cols - anchor.col);

  const splices: Splice[] = [];
  let written = 0;
  for (let i = 0; i < rowSpan; i++) {
    for (let j = 0; j < colSpan; j++) {
      const r = anchor.row + i;
      const c = anchor.col + j;
      const cell = byPosition.get(`${r},${c}`);
      if (!cell) continue;
      const textNode = cellTextNode(cell);
      if (!textNode) {
        throw new CoMotionError(`儲存格 ${r},${c} 缺少 <text>，無法貼上文字`);
      }
      const value = tsvRows[i][j] ?? "";
      splices.push({ start: textNode.contentStart, end: textNode.contentEnd, text: escapeXmlText(value) });
      written++;
    }
  }
  return { updated: applySplices(svgContent, splices), cells: written };
}
