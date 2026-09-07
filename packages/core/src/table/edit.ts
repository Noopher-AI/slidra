import { CoMotionError } from "../errors.js";
import { assertSlideCompliant } from "../slide/format.js";
import { attributeValue, scanDocument } from "../slide/scan.js";
import type { FontMetrics } from "../text-metrics.js";
import { DEFAULT_COL_WIDTH, MIN_COL_WIDTH } from "./layout.js";
import {
  CELL_ALIGNS,
  CELL_FONT_WEIGHTS,
  TABLE_THEMES,
  readTableModel,
  requireTableContainer,
  validateTableModel,
  type CellAlign,
  type TableCell,
  type TableModel,
  type TableTheme,
} from "./model.js";
import { renderTableMarkup } from "./render.js";
import { themedCellStyle } from "./theme.js";
import type { ParsedTableCsv } from "./csv.js";
import type { ParsedMarkdownTable } from "./markdown.js";

/**
 * The container-level rewriters for the `table` command family (plan
 * §4.2): every command re-derives the FULL `TableModel` (`readTableModel`),
 * applies one patch, re-validates the whole result, re-renders the WHOLE
 * container (`render.ts`) and splices it in place of the old one. Row
 * heights and every baked colour are always recomputed here — a partial
 * splice would leave them stale the moment a cell's text (and therefore
 * its row's height) changes.
 */

function requireSvgRoot(roots: ReturnType<typeof scanDocument>) {
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgRoot;
}

function readViewBox(svgContent: string): { width: number; height: number } {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const raw = attributeValue(svgRoot, "viewBox");
  if (!raw) {
    throw new CoMotionError("投影片缺少 viewBox");
  }
  const parts = raw.split(/[\s,]+/).filter((token) => token.length > 0).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new CoMotionError(`投影片的 viewBox 不是四個數字：${raw}`);
  }
  return { width: parts[2], height: parts[3] };
}

function updateTable(
  svgContent: string,
  slidePath: string,
  elementId: string,
  fonts: ReadonlyMap<string, FontMetrics>,
  mutate: (model: TableModel) => TableModel,
): string {
  assertSlideCompliant(svgContent, slidePath);
  const current = readTableModel(svgContent, elementId);
  const next = mutate(current);
  validateTableModel(next);
  const container = requireTableContainer(svgContent, elementId);
  const transform = attributeValue(container, "transform");
  const markup = renderTableMarkup(next, elementId, transform, fonts);
  return svgContent.slice(0, container.start) + markup + svgContent.slice(container.end);
}

/** Reassigns every cell's theme-derived colour fields by its CURRENT row (discards any per-cell style override — plan does not specify override survival across a structural row/theme change, so a later theme/header/row change always re-applies the full theme, predictably). */
function restyleTable(cells: readonly TableCell[], theme: TableTheme, header: boolean): TableCell[] {
  return cells.map((cell) => {
    const style = themedCellStyle(theme, header, cell.row);
    return { ...cell, fill: style.fill, fillOpacity: style.fillOpacity, textFill: style.textFill, fontWeight: style.fontWeight };
  });
}

function buildGridCells(rowCount: number, colCount: number, theme: TableTheme, header: boolean): TableCell[] {
  const cells: TableCell[] = [];
  for (let row = 0; row < rowCount; row++) {
    const style = themedCellStyle(theme, header, row);
    for (let col = 0; col < colCount; col++) {
      cells.push({
        row,
        col,
        text: "",
        align: "left",
        fill: style.fill,
        fillOpacity: style.fillOpacity,
        textFill: style.textFill,
        fontWeight: style.fontWeight,
        rowSpan: 1,
        colSpan: 1,
        repeat: false,
        generated: false,
      });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// table create
// ---------------------------------------------------------------------------

export interface CreateTableInput {
  rows: number;
  cols: number;
  x: number;
  y: number;
  colWidth?: number;
  theme?: TableTheme;
  header?: boolean;
}

export function createTableElement(
  svgContent: string,
  slidePath: string,
  elementId: string,
  input: CreateTableInput,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  assertSlideCompliant(svgContent, slidePath);
  readViewBox(svgContent); // validates the slide has a coordinate system at all

  if (!Number.isInteger(input.rows) || input.rows < 1) {
    throw new CoMotionError(`--rows 必須是大於 0 的整數：${input.rows}`);
  }
  if (!Number.isInteger(input.cols) || input.cols < 1) {
    throw new CoMotionError(`--cols 必須是大於 0 的整數：${input.cols}`);
  }
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    throw new CoMotionError("--x/--y 必須是有限數字");
  }
  const colWidth = input.colWidth ?? DEFAULT_COL_WIDTH;
  if (!Number.isFinite(colWidth) || colWidth <= 0) {
    throw new CoMotionError(`--col-width 必須是大於 0 的有限數字：${colWidth}`);
  }
  const theme = input.theme ?? "dark";
  if (!TABLE_THEMES.includes(theme)) {
    throw new CoMotionError(`不支援的主題，合法值為：${TABLE_THEMES.join("、")}（收到：${theme}）`);
  }
  const header = input.header ?? true;

  const cols = Array.from({ length: input.cols }, () => colWidth);
  const cells = buildGridCells(input.rows, input.cols, theme, header);
  const model: TableModel = { cols, rows: Array(input.rows).fill(0), header, theme, source: null, cells };
  validateTableModel(model);

  const transform = `translate(${input.x} ${input.y})`;
  const markup = renderTableMarkup(model, elementId, transform, fonts);

  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  return svgContent.slice(0, svgRoot.contentEnd) + markup + svgContent.slice(svgRoot.contentEnd);
}

// ---------------------------------------------------------------------------
// table cell set
// ---------------------------------------------------------------------------

export function setTableCellText(
  svgContent: string,
  slidePath: string,
  elementId: string,
  row: number,
  col: number,
  text: string,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    const index = model.cells.findIndex((cell) => cell.row === row && cell.col === col);
    if (index === -1) {
      throw new CoMotionError(`找不到儲存格 (${row},${col})`);
    }
    const cells = model.cells.slice();
    cells[index] = { ...cells[index], text };
    return { ...model, cells };
  });
}

/**
 * [E2.T18] `table cell cut/paste`: sets several cells' text in ONE
 * re-render, so the caller's single `writePresentationFile` is one undo
 * step. Every entry must name a real cell (a span-covered position is not
 * a cell) — the clipboard module filters against the model first.
 */
export function setTableCellTexts(
  svgContent: string,
  slidePath: string,
  elementId: string,
  entries: readonly { row: number; col: number; text: string }[],
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    const cells = model.cells.slice();
    for (const entry of entries) {
      const index = cells.findIndex((cell) => cell.row === entry.row && cell.col === entry.col);
      if (index === -1) {
        throw new CoMotionError(`找不到儲存格 (${entry.row},${entry.col})`);
      }
      cells[index] = { ...cells[index], text: entry.text };
    }
    return { ...model, cells };
  });
}

// ---------------------------------------------------------------------------
// table cell style set
// ---------------------------------------------------------------------------

export type CellStyleAttr = "align" | "fill" | "text-fill" | "font-weight";

export interface SetCellStyleInput {
  row: number;
  col: number;
  rowEnd?: number;
  colEnd?: number;
  attr: CellStyleAttr;
  value: string;
}

const HEX_OR_NONE = /^#([0-9a-fA-F]{6})$/;

export function setTableCellStyle(
  svgContent: string,
  slidePath: string,
  elementId: string,
  input: SetCellStyleInput,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    const rowStart = Math.min(input.row, input.rowEnd ?? input.row);
    const rowEnd = Math.max(input.row, input.rowEnd ?? input.row);
    const colStart = Math.min(input.col, input.colEnd ?? input.col);
    const colEnd = Math.max(input.col, input.colEnd ?? input.col);

    const patch = (cell: TableCell): TableCell => {
      switch (input.attr) {
        case "align": {
          if (!CELL_ALIGNS.includes(input.value as CellAlign)) {
            throw new CoMotionError(`align 必須是下列其中之一：${CELL_ALIGNS.join("、")}（收到：${input.value}）`);
          }
          return { ...cell, align: input.value as CellAlign };
        }
        case "font-weight": {
          const weight = Number(input.value);
          if (!CELL_FONT_WEIGHTS.includes(weight)) {
            throw new CoMotionError(`font-weight 必須是 100 到 900 的整百：${input.value}`);
          }
          return { ...cell, fontWeight: weight };
        }
        case "fill": {
          if (input.value !== "none" && !HEX_OR_NONE.test(input.value)) {
            throw new CoMotionError(`fill 必須是 none 或 #RRGGBB：${input.value}`);
          }
          return { ...cell, fill: input.value, fillOpacity: null };
        }
        case "text-fill": {
          if (!HEX_OR_NONE.test(input.value)) {
            throw new CoMotionError(`text-fill 必須是 #RRGGBB：${input.value}`);
          }
          return { ...cell, textFill: input.value };
        }
        default:
          throw new CoMotionError(`不支援的樣式屬性：${input.attr as string}`);
      }
    };

    let matched = false;
    const cells = model.cells.map((cell) => {
      if (cell.row >= rowStart && cell.row <= rowEnd && cell.col >= colStart && cell.col <= colEnd) {
        matched = true;
        return patch(cell);
      }
      return cell;
    });
    if (!matched) {
      throw new CoMotionError("指定範圍內沒有任何儲存格");
    }
    return { ...model, cells };
  });
}

// ---------------------------------------------------------------------------
// table merge / unmerge
// ---------------------------------------------------------------------------

function rectOverlaps(cell: TableCell, row: number, col: number, rowSpan: number, colSpan: number): boolean {
  return (
    cell.row < row + rowSpan &&
    cell.row + cell.rowSpan > row &&
    cell.col < col + colSpan &&
    cell.col + cell.colSpan > col
  );
}

function splitCell(cell: TableCell): TableCell[] {
  const parts: TableCell[] = [];
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      parts.push({ ...cell, row: r, col: c, rowSpan: 1, colSpan: 1, text: r === cell.row && c === cell.col ? cell.text : "" });
    }
  }
  return parts;
}

export interface MergeTableCellsInput {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  unmerge?: boolean;
}

export function mergeTableCells(
  svgContent: string,
  slidePath: string,
  elementId: string,
  input: MergeTableCellsInput,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    const target = model.cells.find((cell) => cell.row === input.row && cell.col === input.col);
    if (!target) {
      throw new CoMotionError(`找不到儲存格 (${input.row},${input.col})`);
    }

    if (input.unmerge) {
      if (target.rowSpan === 1 && target.colSpan === 1) {
        throw new CoMotionError(`儲存格 (${input.row},${input.col}) 未合併，無法取消合併`);
      }
      const cells = model.cells.filter((cell) => cell !== target).concat(splitCell(target));
      return { ...model, cells };
    }

    const rowSpan = input.rowSpan ?? 1;
    const colSpan = input.colSpan ?? 1;
    if (!Number.isInteger(rowSpan) || !Number.isInteger(colSpan) || rowSpan < 1 || colSpan < 1) {
      throw new CoMotionError("合併範圍必須是正整數");
    }
    if (input.row + rowSpan > model.rows.length || input.col + colSpan > model.cols.length) {
      throw new CoMotionError("合併範圍超出表格");
    }

    // `--row-span 1 --col-span 1` on an already-merged cell is a plain
    // unmerge (plan §4.7 "合法：等同取消合併").
    if (rowSpan === 1 && colSpan === 1) {
      if (target.rowSpan === 1 && target.colSpan === 1) {
        return model; // already unmerged: no-op
      }
      const cells = model.cells.filter((cell) => cell !== target).concat(splitCell(target));
      return { ...model, cells };
    }

    const covered = model.cells.filter((cell) => rectOverlaps(cell, input.row, input.col, rowSpan, colSpan));
    for (const cell of covered) {
      const withinRow = cell.row >= input.row && cell.row + cell.rowSpan <= input.row + rowSpan;
      const withinCol = cell.col >= input.col && cell.col + cell.colSpan <= input.col + colSpan;
      if (!withinRow || !withinCol) {
        throw new CoMotionError("合併範圍與既有合併重疊");
      }
    }

    const remaining = model.cells.filter((cell) => !covered.includes(cell));
    const merged: TableCell = { ...target, row: input.row, col: input.col, rowSpan, colSpan };
    return { ...model, cells: [...remaining, merged] };
  });
}

// ---------------------------------------------------------------------------
// table col width / insert / delete
// ---------------------------------------------------------------------------

export function setTableColWidth(
  svgContent: string,
  slidePath: string,
  elementId: string,
  col: number,
  width: number,
  fonts: ReadonlyMap<string, FontMetrics>,
  /** `--keep-total`: the column to the right absorbs the difference so the table's total width is unchanged — what dragging a column boundary in the GUI means. */
  keepTotal = false,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    if (!Number.isInteger(col) || col < 0 || col >= model.cols.length) {
      throw new CoMotionError(`--col 超出範圍：${col}`);
    }
    if (!Number.isFinite(width) || width <= 0) {
      throw new CoMotionError(`--width 必須是大於 0 的有限數字：${width}`);
    }
    const cols = model.cols.slice();
    if (keepTotal) {
      if (col === model.cols.length - 1) {
        throw new CoMotionError("--keep-total 需要右邊還有一欄可以吸收差值：最後一欄不適用");
      }
      const next = cols[col + 1] - (width - cols[col]);
      if (next < MIN_COL_WIDTH) {
        throw new CoMotionError(`右邊那欄會小於最小欄寬 ${MIN_COL_WIDTH}：${next}`);
      }
      cols[col + 1] = next;
    }
    cols[col] = width;
    return { ...model, cols };
  });
}

export function insertTableColumn(
  svgContent: string,
  slidePath: string,
  elementId: string,
  at: number,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    if (!Number.isInteger(at) || at < 0 || at > model.cols.length) {
      throw new CoMotionError(`--at 超出範圍：${at}`);
    }
    const cols = model.cols.slice();
    cols.splice(at, 0, DEFAULT_COL_WIDTH);

    const spannedRows = new Set<number>();
    const cells = model.cells.map((cell) => {
      if (cell.col + cell.colSpan <= at) return cell;
      if (cell.col >= at) return { ...cell, col: cell.col + 1 };
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++) spannedRows.add(r);
      return { ...cell, colSpan: cell.colSpan + 1 };
    });

    for (let row = 0; row < model.rows.length; row++) {
      if (spannedRows.has(row)) continue;
      const style = themedCellStyle(model.theme, model.header, row);
      const repeat = model.cells.some((cell) => cell.row === row && cell.repeat);
      const generated = model.cells.some((cell) => cell.row === row && cell.generated);
      cells.push({
        row,
        col: at,
        text: "",
        align: "left",
        fill: style.fill,
        fillOpacity: style.fillOpacity,
        textFill: style.textFill,
        fontWeight: style.fontWeight,
        rowSpan: 1,
        colSpan: 1,
        repeat,
        generated,
      });
    }

    return { ...model, cols, cells };
  });
}

export function deleteTableColumn(
  svgContent: string,
  slidePath: string,
  elementId: string,
  at: number,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    if (!Number.isInteger(at) || at < 0 || at >= model.cols.length) {
      throw new CoMotionError(`--at 超出範圍：${at}`);
    }
    if (model.cols.length === 1) {
      throw new CoMotionError("表格至少要有一欄");
    }
    const cols = model.cols.slice();
    cols.splice(at, 1);

    const cells: TableCell[] = [];
    for (const cell of model.cells) {
      if (cell.col <= at && cell.col + cell.colSpan > at) {
        const newSpan = cell.colSpan - 1;
        if (newSpan <= 0) continue;
        cells.push({ ...cell, colSpan: newSpan });
      } else if (cell.col > at) {
        cells.push({ ...cell, col: cell.col - 1 });
      } else {
        cells.push(cell);
      }
    }
    return { ...model, cols, cells };
  });
}

// ---------------------------------------------------------------------------
// table row insert / delete
// ---------------------------------------------------------------------------

export function insertTableRow(
  svgContent: string,
  slidePath: string,
  elementId: string,
  at: number,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    if (!Number.isInteger(at) || at < 0 || at > model.rows.length) {
      throw new CoMotionError(`--at 超出範圍：${at}`);
    }
    const spannedCols = new Set<number>();
    let cells: TableCell[] = model.cells.map((cell) => {
      if (cell.row + cell.rowSpan <= at) return cell;
      if (cell.row >= at) return { ...cell, row: cell.row + 1 };
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) spannedCols.add(c);
      return { ...cell, rowSpan: cell.rowSpan + 1 };
    });

    for (let col = 0; col < model.cols.length; col++) {
      if (spannedCols.has(col)) continue;
      cells.push({
        row: at,
        col,
        text: "",
        align: "left",
        fill: "none",
        fillOpacity: null,
        textFill: "#000000",
        fontWeight: 400,
        rowSpan: 1,
        colSpan: 1,
        repeat: false,
        generated: false,
      });
    }

    cells = restyleTable(cells, model.theme, model.header);
    return { ...model, rows: Array(model.rows.length + 1).fill(0), cells };
  });
}

export function deleteTableRow(
  svgContent: string,
  slidePath: string,
  elementId: string,
  at: number,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    if (!Number.isInteger(at) || at < 0 || at >= model.rows.length) {
      throw new CoMotionError(`--at 超出範圍：${at}`);
    }
    if (model.rows.length === 1) {
      throw new CoMotionError("表格至少要有一列");
    }
    const isTemplateRow = model.cells.some((cell) => cell.row === at && cell.repeat);
    if (isTemplateRow) {
      throw new CoMotionError("模板列不可刪除，請先解除綁定");
    }

    let cells: TableCell[] = [];
    for (const cell of model.cells) {
      if (cell.row <= at && cell.row + cell.rowSpan > at) {
        const newSpan = cell.rowSpan - 1;
        if (newSpan <= 0) continue;
        cells.push({ ...cell, rowSpan: newSpan });
      } else if (cell.row > at) {
        cells.push({ ...cell, row: cell.row - 1 });
      } else {
        cells.push(cell);
      }
    }
    cells = restyleTable(cells, model.theme, model.header);
    return { ...model, rows: Array(model.rows.length - 1).fill(0), cells };
  });
}

// ---------------------------------------------------------------------------
// table theme set / header set
// ---------------------------------------------------------------------------

export function setTableTheme(
  svgContent: string,
  slidePath: string,
  elementId: string,
  theme: TableTheme,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  if (!TABLE_THEMES.includes(theme)) {
    throw new CoMotionError(`不支援的主題，合法值為：${TABLE_THEMES.join("、")}（收到：${theme}）`);
  }
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => ({
    ...model,
    theme,
    cells: restyleTable(model.cells, theme, model.header),
  }));
}

export function setTableHeader(
  svgContent: string,
  slidePath: string,
  elementId: string,
  header: boolean,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => ({
    ...model,
    header,
    cells: restyleTable(model.cells, model.theme, header),
  }));
}

// ---------------------------------------------------------------------------
// table bind / refresh — CSV expansion (plan §4.4)
// ---------------------------------------------------------------------------

const CELL_VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

function substituteTemplate(text: string, headers: readonly string[], values: readonly string[]): string {
  return text.replace(CELL_VARIABLE_PATTERN, (_match, rawName: string) => {
    const name = rawName.trim();
    if (name === "") {
      throw new CoMotionError("模板格的 {{ }} 不可為空名稱");
    }
    const index = headers.indexOf(name);
    if (index === -1) {
      throw new CoMotionError(`找不到欄名 {{ ${name} }}，可用欄名：${headers.join("、")}`);
    }
    return values[index];
  });
}

/** Removes every `generated` cell and re-numbers the remaining rows contiguously — the "刪掉所有 generated 儲存格" half of a refresh. */
function stripGeneratedRows(cells: readonly TableCell[]): TableCell[] {
  const remaining = cells.filter((cell) => !cell.generated);
  const uniqueRows = Array.from(new Set(remaining.map((cell) => cell.row))).sort((a, b) => a - b);
  const remap = new Map(uniqueRows.map((row, index) => [row, index]));
  return remaining.map((cell) => ({ ...cell, row: remap.get(cell.row)! }));
}

function expandTemplateRow(
  cells: readonly TableCell[],
  templateRow: number,
  csv: ParsedTableCsv,
): { cells: TableCell[]; rowCount: number } {
  const templateCells = cells.filter((cell) => cell.row === templateRow);
  const shifted = cells.map((cell) => (cell.row > templateRow ? { ...cell, row: cell.row + csv.rows.length } : cell));

  const generated: TableCell[] = [];
  csv.rows.forEach((values, rowOffset) => {
    const newRow = templateRow + 1 + rowOffset;
    for (const templateCell of templateCells) {
      generated.push({
        ...templateCell,
        row: newRow,
        text: substituteTemplate(templateCell.text, csv.headers, values),
        repeat: false,
        generated: true,
      });
    }
  });

  const rowCount = new Set(shifted.map((cell) => cell.row)).size + csv.rows.length;
  return { cells: [...shifted, ...generated], rowCount };
}

export function bindTableSource(
  svgContent: string,
  slidePath: string,
  elementId: string,
  source: string,
  templateRow: number | undefined,
  csv: ParsedTableCsv,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    const stripped = stripGeneratedRows(model.cells).map((cell) => ({ ...cell, repeat: false }));
    const rowCountAfterStrip = new Set(stripped.map((cell) => cell.row)).size;

    let resolvedTemplateRow: number;
    if (templateRow !== undefined) {
      if (!Number.isInteger(templateRow) || templateRow < 0 || templateRow >= rowCountAfterStrip) {
        throw new CoMotionError(`--template-row 超出範圍：${templateRow}`);
      }
      resolvedTemplateRow = templateRow;
      if (model.header && resolvedTemplateRow === 0) {
        throw new CoMotionError("表頭列不能當模板列");
      }
    } else {
      if (model.header && rowCountAfterStrip === 1) {
        throw new CoMotionError("表格只有表頭列，沒有可當模板的列");
      }
      // Default: the first body row that already carries a `{{ column }}`
      // placeholder — that is the row the author prepared as the template;
      // only when no row has one does the last row stand in.
      const placeholderRow = stripped
        .filter((cell) => cell.text.includes("{{") && !(model.header && cell.row === 0))
        .map((cell) => cell.row)
        .sort((a, b) => a - b)[0];
      resolvedTemplateRow = placeholderRow ?? rowCountAfterStrip - 1;
    }

    const withTemplateMark = stripped.map((cell) =>
      cell.row === resolvedTemplateRow ? { ...cell, repeat: true } : cell,
    );
    const { cells, rowCount } = expandTemplateRow(withTemplateMark, resolvedTemplateRow, csv);
    return { ...model, source, rows: Array(rowCount).fill(0), cells };
  });
}

export function refreshTableSource(
  svgContent: string,
  slidePath: string,
  elementId: string,
  csv: ParsedTableCsv,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) => {
    if (model.source === null) {
      throw new CoMotionError(`表格 ${elementId} 沒有資料來源`);
    }
    const stripped = stripGeneratedRows(model.cells);
    const templateRow = stripped.find((cell) => cell.repeat)?.row;
    if (templateRow === undefined) {
      throw new CoMotionError(`表格 ${elementId} 沒有模板列`);
    }
    const { cells, rowCount } = expandTemplateRow(stripped, templateRow, csv);
    return { ...model, rows: Array(rowCount).fill(0), cells };
  });
}

// ---------------------------------------------------------------------------
// table set --from / --markdown
// ---------------------------------------------------------------------------

interface GridData {
  headers: string[];
  rows: string[][];
  aligns?: CellAlign[];
}

function buildTableFromGrid(existingCols: readonly number[], theme: TableTheme, data: GridData): TableModel {
  const colCount = data.headers.length;
  const cols = Array.from({ length: colCount }, (_, index) => existingCols[index] ?? DEFAULT_COL_WIDTH);
  const allRows = [data.headers, ...data.rows];
  const cells: TableCell[] = [];
  allRows.forEach((rowValues, row) => {
    const style = themedCellStyle(theme, true, row);
    rowValues.forEach((text, col) => {
      cells.push({
        row,
        col,
        text,
        align: data.aligns?.[col] ?? "left",
        fill: style.fill,
        fillOpacity: style.fillOpacity,
        textFill: style.textFill,
        fontWeight: style.fontWeight,
        rowSpan: 1,
        colSpan: 1,
        repeat: false,
        generated: false,
      });
    });
  });
  return { cols, rows: Array(allRows.length).fill(0), header: true, theme, source: null, cells };
}

export function setTableFromCsv(
  svgContent: string,
  slidePath: string,
  elementId: string,
  csv: ParsedTableCsv,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) =>
    buildTableFromGrid(model.cols, model.theme, { headers: csv.headers, rows: csv.rows }),
  );
}

export function setTableFromMarkdown(
  svgContent: string,
  slidePath: string,
  elementId: string,
  markdown: ParsedMarkdownTable,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  return updateTable(svgContent, slidePath, elementId, fonts, (model) =>
    buildTableFromGrid(model.cols, model.theme, { headers: markdown.headers, rows: markdown.rows, aligns: markdown.aligns }),
  );
}
