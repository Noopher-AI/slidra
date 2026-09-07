import { CoMotionError } from "../errors.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "../slide/scan.js";
import { unescapeXmlText } from "../element-text.js";
import { EFFECTS_NS } from "../effects/index.js";

/**
 * The table container's data model (E2.T14, #203). Pure `svgContent: string
 * -> value` / `value -> string` functions, no `node:` imports — the front
 * end's local overlay/preview channel has to load this too.
 *
 * Structural shape (plan §4.1, 已定案):
 *
 *   <g id="el-…" data-comot-type="table" data-comot-cols="200 300 240"
 *      data-comot-rows="44 40" data-comot-header="1" data-comot-theme="dark"
 *      transform="translate(x y)">
 *     <comot:source xmlns:comot="…" src="assets/data/x.csv"/>
 *     <g data-comot-cell="0,0" transform="translate(0 0)">
 *       <rect x="0" y="0" width="…" height="…" fill="…" .../>
 *       <text x="…" y="…" ...><tspan ...>…</tspan></text>
 *     </g>
 *     …
 *   </g>
 *
 * Cell containers never carry `id` — addressing is by `data-comot-cell`
 * only (§4.1). A cell covered by a merge is removed from the document
 * entirely, never left as an invisible placeholder.
 */

export const TABLE_CONTAINER_TYPE = "table";
export const TABLE_SOURCE_TAG = "comot:source";
export const TABLE_NS = EFFECTS_NS;

export type TableTheme = "dark" | "light" | "zebra";
export const TABLE_THEMES: readonly TableTheme[] = ["dark", "light", "zebra"];

export type CellAlign = "left" | "center" | "right";
export const CELL_ALIGNS: readonly CellAlign[] = ["left", "center", "right"];

export const CELL_FONT_WEIGHTS: readonly number[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];

const HEX_COLOR = /^#([0-9a-fA-F]{6})$/;

export interface TableCell {
  row: number;
  col: number;
  text: string;
  align: CellAlign;
  /** Native `fill` on the cell's `<rect>` — `"none"` or `#RRGGBB`, always concrete (never a theme indirection, never `rgba()`). */
  fill: string;
  /** `fill-opacity` on the cell's `<rect>`; `null` means the attribute is omitted (fully opaque). */
  fillOpacity: number | null;
  /** Native `fill` on the cell's `<text>`, always `#RRGGBB`. */
  textFill: string;
  fontWeight: number;
  rowSpan: number;
  colSpan: number;
  /** `data-comot-repeat="row"`: this cell belongs to the bound table's template row. Always paired with `display="none"`. */
  repeat: boolean;
  /** `data-comot-generated="1"`: produced by `table bind`/`table refresh` from CSV data. */
  generated: boolean;
}

export interface TableModel {
  /** Column widths, user units, left to right. */
  cols: number[];
  /** Row heights, user units, top to bottom — always core-computed, never user-specified (決定 2). A hidden template row's height is 0. */
  rows: number[];
  header: boolean;
  theme: TableTheme;
  /** `assets/data/….csv` virtual path, or `null` when the table is not bound. */
  source: string | null;
  /** Every real cell (span-covered positions are not separate entries). */
  cells: TableCell[];
}

function requireEnum<T extends string>(value: string, domain: readonly T[], label: string): T {
  if (!(domain as readonly string[]).includes(value)) {
    throw new CoMotionError(`${label} 必須是下列其中之一：${domain.join("、")}（收到：${value}）`);
  }
  return value as T;
}

/**
 * Every invariant a `TableModel` must hold before it can be rendered: the
 * grid geometry, the cell/span coverage (every row×col position covered by
 * exactly one cell), and every enum field. Called before every write.
 */
export function validateTableModel(model: TableModel): void {
  if (model.cols.length === 0) {
    throw new CoMotionError("表格至少要有一欄");
  }
  if (model.rows.length === 0) {
    throw new CoMotionError("表格至少要有一列");
  }
  for (const width of model.cols) {
    if (!Number.isFinite(width) || width <= 0) {
      throw new CoMotionError(`欄寬必須是大於 0 的有限數字：${width}`);
    }
  }
  for (const height of model.rows) {
    if (!Number.isFinite(height) || height < 0) {
      throw new CoMotionError(`列高必須是不小於 0 的有限數字：${height}`);
    }
  }
  requireEnum(model.theme, TABLE_THEMES, "theme");

  const rowCount = model.rows.length;
  const colCount = model.cols.length;
  const covered: boolean[][] = Array.from({ length: rowCount }, () => new Array(colCount).fill(false));

  for (const cell of model.cells) {
    if (cell.rowSpan < 1 || cell.colSpan < 1) {
      throw new CoMotionError(`儲存格 (${cell.row},${cell.col}) 的合併範圍必須是正整數`);
    }
    if (cell.row < 0 || cell.col < 0 || cell.row + cell.rowSpan > rowCount || cell.col + cell.colSpan > colCount) {
      throw new CoMotionError(`儲存格 (${cell.row},${cell.col}) 的範圍超出表格`);
    }
    requireEnum(cell.align, CELL_ALIGNS, `儲存格 (${cell.row},${cell.col}) 的 align`);
    if (!CELL_FONT_WEIGHTS.includes(cell.fontWeight)) {
      throw new CoMotionError(`儲存格 (${cell.row},${cell.col}) 的 font-weight 必須是 100 到 900 的整百：${cell.fontWeight}`);
    }
    if (cell.fill !== "none" && !HEX_COLOR.test(cell.fill)) {
      throw new CoMotionError(`儲存格 (${cell.row},${cell.col}) 的 fill 必須是 none 或 #RRGGBB：${cell.fill}`);
    }
    if (cell.fillOpacity !== null && (!Number.isFinite(cell.fillOpacity) || cell.fillOpacity < 0 || cell.fillOpacity > 1)) {
      throw new CoMotionError(`儲存格 (${cell.row},${cell.col}) 的 fill-opacity 必須介於 0 到 1 之間`);
    }
    if (!HEX_COLOR.test(cell.textFill)) {
      throw new CoMotionError(`儲存格 (${cell.row},${cell.col}) 的 text-fill 必須是 #RRGGBB：${cell.textFill}`);
    }
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
        if (covered[r][c]) {
          throw new CoMotionError(`合併範圍與既有合併重疊`);
        }
        covered[r][c] = true;
      }
    }
  }

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      if (!covered[r][c]) {
        throw new CoMotionError(`儲存格 (${r},${c}) 沒有任何內容，表格的格線沒有完整覆蓋`);
      }
    }
  }

  const templateRows = new Set(model.cells.filter((cell) => cell.repeat).map((cell) => cell.row));
  if (templateRows.size > 1) {
    throw new CoMotionError("模板列只能有一列");
  }
}

/**
 * The STRUCTURAL half of table validity — what `slide/format.ts`'s
 * `checkSlideCompliance` needs to decide `invalid-table-shape` without
 * fully parsing cell content (compliance is about structure only, per that
 * module's own header comment). Returns a description of the first problem
 * found, or `null` when the shape is fine. Deeper checks (grid coverage,
 * span overlap) are `validateTableModel`'s job, run only when a `table`
 * command actually reads the container.
 */
export function describeTableShapeProblem(container: ScannedNode): string | null {
  const colsRaw = attributeOf(container, "data-comot-cols")?.value;
  const rowsRaw = attributeOf(container, "data-comot-rows")?.value;
  if (colsRaw === undefined || rowsRaw === undefined) {
    return "表格容器缺少 data-comot-cols 或 data-comot-rows";
  }
  const cols = colsRaw.split(/\s+/).filter((token) => token.length > 0);
  const rows = rowsRaw.split(/\s+/).filter((token) => token.length > 0);
  if (cols.length === 0 || cols.some((token) => !Number.isFinite(Number(token)))) {
    return "data-comot-cols 不是合法的數字列表";
  }
  if (rows.length === 0 || rows.some((token) => !Number.isFinite(Number(token)))) {
    return "data-comot-rows 不是合法的數字列表";
  }

  const sourceNodes = container.children.filter((child) => child.tag === TABLE_SOURCE_TAG);
  if (sourceNodes.length > 1) {
    return `表格容器必須恰好包含一個 <${TABLE_SOURCE_TAG}>`;
  }

  const others = container.children.filter(
    (child) => child.tag !== TABLE_SOURCE_TAG && attributeOf(child, "data-comot-cell") === undefined,
  );
  if (others.length > 0) {
    return `表格容器不可含有非儲存格的 <${others[0].tag}>`;
  }

  const cellNodes = container.children.filter((child) => attributeOf(child, "data-comot-cell") !== undefined);
  for (const cellNode of cellNodes) {
    if (cellNode.tag !== "g") {
      return "儲存格必須是 <g> 容器";
    }
    const address = attributeOf(cellNode, "data-comot-cell")!.value;
    const match = /^(\d+),(\d+)$/.exec(address);
    if (!match) {
      return `data-comot-cell 格式錯誤：${address}`;
    }
    const [row, col] = [Number(match[1]), Number(match[2])];
    if (row < 0 || row >= rows.length || col < 0 || col >= cols.length) {
      return `儲存格 (${row},${col}) 超出表格範圍`;
    }
    const nestedGroups = cellNode.children.filter((grandchild) => grandchild.tag === "g");
    if (nestedGroups.length > 0) {
      return `儲存格 (${row},${col}) 內不可含有子 <g>`;
    }
  }

  return null;
}

/** Locates a table's container `<g>` by id. Throws `找不到元素` when absent, and a distinct message when the element exists but is not a table. */
export function requireTableContainer(svgContent: string, elementId: string): ScannedNode {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  const found = findTableContainer(svgRoot, elementId);
  if (!found) {
    throw new CoMotionError(`找不到元素：${elementId}`);
  }
  if (attributeValue(found, "data-comot-type") !== TABLE_CONTAINER_TYPE) {
    throw new CoMotionError(`元素 ${elementId} 不是表格`);
  }
  return found;
}

function findTableContainer(parent: ScannedNode, id: string): ScannedNode | undefined {
  for (const child of parent.children) {
    if (child.tag !== "g") continue;
    if (attributeValue(child, "id") === id) return child;
    const found = findTableContainer(child, id);
    if (found) return found;
  }
  return undefined;
}

function parseNumberList(raw: string, elementId: string, attr: string): number[] {
  const parts = raw.split(/\s+/).filter((token) => token.length > 0);
  return parts.map((token) => {
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new CoMotionError(`元素 ${elementId} 的 ${attr} 含非數字：${token}`);
    }
    return value;
  });
}

function parseCellAddress(raw: string, elementId: string): { row: number; col: number } {
  const match = /^(\d+),(\d+)$/.exec(raw);
  if (!match) {
    throw new CoMotionError(`元素 ${elementId} 的儲存格位址格式錯誤：${raw}`);
  }
  return { row: Number(match[1]), col: Number(match[2]) };
}

/**
 * Reads `elementId`'s table container back into a `TableModel`. Structural
 * legality beyond "parses at all" (grid coverage, span overlap) is
 * re-checked by `validateTableModel` at the end, so a model this function
 * returns is always safe to hand to `layout.ts`/`render.ts`.
 */
export function readTableModel(svgContent: string, elementId: string): TableModel {
  const container = requireTableContainer(svgContent, elementId);

  const colsRaw = attributeOf(container, "data-comot-cols");
  if (!colsRaw) {
    throw new CoMotionError(`元素 ${elementId} 缺少 data-comot-cols`);
  }
  const rowsRaw = attributeOf(container, "data-comot-rows");
  if (!rowsRaw) {
    throw new CoMotionError(`元素 ${elementId} 缺少 data-comot-rows`);
  }
  const cols = parseNumberList(colsRaw.value, elementId, "data-comot-cols");
  const rows = parseNumberList(rowsRaw.value, elementId, "data-comot-rows");

  const headerRaw = attributeValue(container, "data-comot-header");
  const header = headerRaw === "1";
  const themeRaw = attributeValue(container, "data-comot-theme") ?? "dark";
  const theme = requireEnum(themeRaw, TABLE_THEMES, `元素 ${elementId} 的 data-comot-theme`);

  const sourceNodes = container.children.filter((child) => child.tag === TABLE_SOURCE_TAG);
  if (sourceNodes.length > 1) {
    throw new CoMotionError(`元素 ${elementId} 有多個 <${TABLE_SOURCE_TAG}>`);
  }
  const source = sourceNodes.length === 1 ? attributeOf(sourceNodes[0], "src")?.value ?? null : null;

  const cellNodes = container.children.filter((child) => attributeOf(child, "data-comot-cell") !== undefined);
  const cells: TableCell[] = cellNodes.map((cellNode) => {
    const address = parseCellAddress(attributeOf(cellNode, "data-comot-cell")!.value, elementId);
    const spanRaw = attributeOf(cellNode, "data-comot-span")?.value;
    let rowSpan = 1;
    let colSpan = 1;
    if (spanRaw !== undefined) {
      const match = /^(\d+),(\d+)$/.exec(spanRaw);
      if (!match) {
        throw new CoMotionError(`元素 ${elementId} 的 data-comot-span 格式錯誤：${spanRaw}`);
      }
      rowSpan = Number(match[1]);
      colSpan = Number(match[2]);
    }
    const repeat = attributeValue(cellNode, "data-comot-repeat") === "row";
    const generated = attributeValue(cellNode, "data-comot-generated") === "1";

    const rectNode = cellNode.children.find((child) => child.tag === "rect");
    const textNode = cellNode.children.find((child) => child.tag === "text");
    const fill = rectNode ? attributeValue(rectNode, "fill") ?? "none" : "none";
    const fillOpacityRaw = rectNode ? attributeValue(rectNode, "fill-opacity") : null;
    const fillOpacity = fillOpacityRaw !== null ? Number(fillOpacityRaw) : null;
    const textFill = textNode ? attributeValue(textNode, "fill") ?? "#000000" : "#000000";
    const fontWeightRaw = textNode ? attributeValue(textNode, "font-weight") : null;
    const fontWeight = fontWeightRaw !== null ? Number(fontWeightRaw) : 400;
    const alignRaw = attributeValue(cellNode, "data-comot-align") ?? "left";
    const align = requireEnum(alignRaw, CELL_ALIGNS, `儲存格 (${address.row},${address.col}) 的 data-comot-align`);

    const text = readCellText(cellNode, svgContent);

    return {
      row: address.row,
      col: address.col,
      text,
      align,
      fill,
      fillOpacity,
      textFill,
      fontWeight,
      rowSpan,
      colSpan,
      repeat,
      generated,
    };
  });

  const model: TableModel = { cols, rows, header, theme, source, cells };
  validateTableModel(model);
  return model;
}

/**
 * Reassembles a cell's `<text>` tspans back into plain text — the inverse
 * of `wrapText` + `renderTextBoxContent`'s tspan emission. Only a tspan
 * carrying `data-comot-break="1"` (a HARD break, i.e. a `\n` in the
 * original text) gets a `\n` appended after it; an ordinary soft-wrapped
 * line is concatenated directly, with no separator — conflating the two
 * would insert a `\n` the author never typed every time a cell's content
 * merely wraps to a second line.
 */
function readCellText(cellNode: ScannedNode, svgContent: string): string {
  const textNode = cellNode.children.find((child) => child.tag === "text");
  if (!textNode) return "";
  const tspans = textNode.children.filter((child) => child.tag === "tspan");
  if (tspans.length === 0) return "";
  return tspans
    .map((tspan) => {
      const text = unescapeXmlText(svgContent.slice(tspan.contentStart, tspan.contentEnd));
      return attributeValue(tspan, "data-comot-break") === "1" ? `${text}\n` : text;
    })
    .join("");
}
