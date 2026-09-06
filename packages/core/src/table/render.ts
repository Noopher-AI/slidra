import { escapeXmlAttr } from "../element-text.js";
import { renderTextBoxContent } from "../text/render.js";
import { formatSvgNumber } from "../svg-number.js";
import type { FontMetrics } from "../text-metrics.js";
import { computeTableLayout, CELL_PADDING_X, CELL_PADDING_Y, type CellLayout } from "./layout.js";
import { TABLE_CONTAINER_TYPE, TABLE_NS, TABLE_SOURCE_TAG, type TableModel } from "./model.js";

/**
 * Serializes a `TableModel` into the full `<g data-comot-type="table">…</g>`
 * markup (plan §4.1, 已定案). A pure function: `table/edit.ts`'s every
 * write re-renders the WHOLE container and splices it in place of the old
 * one — row heights, cell geometry, and every baked colour always agree
 * with the model that produced them, never a stale partial patch.
 */
export function renderTableMarkup(
  model: TableModel,
  elementId: string,
  transform: string | null,
  fonts: ReadonlyMap<string, FontMetrics>,
): string {
  const layout = computeTableLayout(model, fonts);

  const colsAttr = model.cols.map((value) => formatSvgNumber(value)).join(" ");
  const rowsAttr = layout.rows.map((value) => formatSvgNumber(value)).join(" ");
  const headerAttr = model.header ? ` data-comot-header="1"` : "";
  const transformAttr = transform !== null ? ` transform="${escapeXmlAttr(transform)}"` : "";
  const sourceMarkup =
    model.source !== null
      ? `<${TABLE_SOURCE_TAG} xmlns:comot="${TABLE_NS}" src="${escapeXmlAttr(model.source)}"/>`
      : "";
  const cellsMarkup = layout.cells
    .slice()
    .sort((a, b) => a.cell.row - b.cell.row || a.cell.col - b.cell.col)
    .map((cellLayout) => renderCellMarkup(cellLayout))
    .join("");

  return (
    `<g id="${escapeXmlAttr(elementId)}" data-comot-type="${TABLE_CONTAINER_TYPE}" ` +
    `data-comot-cols="${colsAttr}" data-comot-rows="${rowsAttr}"${headerAttr} ` +
    `data-comot-theme="${model.theme}"${transformAttr}>${sourceMarkup}${cellsMarkup}</g>`
  );
}

function renderCellMarkup(layout: CellLayout): string {
  const { cell } = layout;
  const spanAttr = cell.rowSpan > 1 || cell.colSpan > 1 ? ` data-comot-span="${cell.rowSpan},${cell.colSpan}"` : "";
  const repeatAttr = cell.repeat ? ` data-comot-repeat="row" display="none"` : "";
  const generatedAttr = cell.generated ? ` data-comot-generated="1"` : "";
  const alignAttr = cell.align !== "left" ? ` data-comot-align="${cell.align}"` : "";
  const cellTransform = ` transform="translate(${formatSvgNumber(layout.x)} ${formatSvgNumber(layout.y)})"`;

  const fillOpacityAttr = cell.fillOpacity !== null ? ` fill-opacity="${formatSvgNumber(cell.fillOpacity)}"` : "";
  const rect =
    // `pointer-events="all"` is required, not cosmetic: SVG's default hit-
    // testing model (`visiblePainted`) never hit-tests a shape whose own
    // fill is "none" — exactly the dark theme's non-header/non-zebra rows
    // (§3.10) — so without this, a click/right-click on such a cell falls
    // straight through to whatever sits behind the whole table in z-order
    // (found via the manual browser smoke test, not a unit test: every
    // core/CLI test writes and reads bytes, none of them asks a real
    // browser what receives a pointer event).
    `<rect x="0" y="0" width="${formatSvgNumber(layout.width)}" height="${formatSvgNumber(layout.height)}" ` +
    `fill="${escapeXmlAttr(cell.fill)}"${fillOpacityAttr} pointer-events="all"/>`;

  const firstLine = layout.wrapped.lines[0];
  const textX = CELL_PADDING_X + firstLine.x;
  const textY = CELL_PADDING_Y + firstLine.y;
  const content = renderTextBoxContent(
    layout.wrapped.lines.map((line) => ({ ...line, x: line.x + CELL_PADDING_X, y: line.y + CELL_PADDING_Y })),
  );
  const text =
    `<text x="${formatSvgNumber(textX)}" y="${formatSvgNumber(textY)}" font-size="${formatSvgNumber(layout.fontSize)}" ` +
    `font-weight="${formatSvgNumber(cell.fontWeight)}" fill="${escapeXmlAttr(cell.textFill)}" xml:space="preserve">${content}</text>`;

  return `<g data-comot-cell="${cell.row},${cell.col}"${spanAttr}${repeatAttr}${generatedAttr}${alignAttr}${cellTransform}>${rect}${text}</g>`;
}
