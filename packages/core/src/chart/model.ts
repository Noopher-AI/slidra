import { CoMotionError } from "../errors.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "../slide/scan.js";
import { CHART_CONTAINER_TYPE } from "../slide/format.js";
import { EFFECTS_NS } from "../effects/index.js";
import { formatSvgNumber } from "../svg-number.js";
import { escapeXmlAttr } from "../element-text.js";

/**
 * The `<comot:chart>` data model (E2.T12, ADR-0012 amended). Pure
 * `svgContent: string -> value` / `value -> string` functions, no `node:`
 * imports — the front end's local preview channel (`chart/edit.ts`'s
 * `previewChartModel`) has to run this too.
 */

export type ChartType = "bar" | "hbar" | "line" | "area" | "pie" | "donut";
export type ChartPalette = "brand" | "cool" | "warm";
export type ChartLegend = "none" | "bottom" | "right";
export type ChartAxesMode = "single" | "dual";
export type ChartSeriesAxis = "left" | "right";

export const CHART_TYPES: readonly ChartType[] = ["bar", "hbar", "line", "area", "pie", "donut"];
export const CHART_PALETTES: readonly ChartPalette[] = ["brand", "cool", "warm"];
export const CHART_LEGENDS: readonly ChartLegend[] = ["none", "bottom", "right"];
/** Only these three types have a meaningful "stack" (ADR-0012 amendment). */
export const CHART_STACKABLE_TYPES: readonly ChartType[] = ["bar", "hbar", "area"];

export const CHART_MIN_CATEGORIES = 2;
export const CHART_MAX_CATEGORIES = 60;
export const CHART_MIN_SERIES = 1;
export const CHART_MAX_SERIES = 12;
/** `chart create`'s own, tighter caps (原型插入面板的邊界, plan §4.4). */
export const CHART_CREATE_MAX_SERIES = 4;
export const CHART_CREATE_MAX_CATEGORIES = 12;

/** Same namespace `<comot:effects>`/`<comot:notes>` already bind (plan §3.2, §0.1 決定 2). */
export const CHART_NS = EFFECTS_NS;

export interface ChartSeries {
  name: string;
  values: number[];
  axis: ChartSeriesAxis;
  /** `null` when unset — the renderer falls back to the palette's `i % 6` colour. */
  color: string | null;
}

export interface ChartModel {
  type: ChartType;
  stacked: boolean;
  axes: ChartAxesMode;
  palette: ChartPalette;
  legend: ChartLegend;
  grid: boolean;
  labels: boolean;
  xTitle: string;
  yTitle: string;
  width: number;
  height: number;
  series: ChartSeries[];
  categories: string[];
}

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function requireEnum<T extends string>(value: string, domain: readonly T[], label: string): T {
  if (!(domain as readonly string[]).includes(value)) {
    throw new CoMotionError(`${label} 必須是下列其中之一：${domain.join("、")}（收到：${value}）`);
  }
  return value as T;
}

function requireFiniteNumbers(values: readonly number[], context: string): void {
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new CoMotionError(`${context}的第 ${index + 1} 個值不是有限數字：${value}`);
    }
  });
}

/**
 * Every invariant a `<comot:chart>` must hold for `renderChartSvg` to
 * produce a sane picture — the boundary table in plan §4.4. Called before
 * every write (`chart/edit.ts`) and after every read (`readChartModel`
 * below): a model this function accepts is always safe to render.
 */
export function validateChartModel(model: ChartModel): void {
  requireEnum(model.type, CHART_TYPES, "type");
  requireEnum(model.palette, CHART_PALETTES, "palette");
  requireEnum(model.legend, CHART_LEGENDS, "legend");

  if (!Number.isFinite(model.width) || !(model.width > 0)) {
    throw new CoMotionError(`width 必須是大於 0 的有限數字：${model.width}`);
  }
  if (!Number.isFinite(model.height) || !(model.height > 0)) {
    throw new CoMotionError(`height 必須是大於 0 的有限數字：${model.height}`);
  }

  if (model.categories.length < CHART_MIN_CATEGORIES || model.categories.length > CHART_MAX_CATEGORIES) {
    throw new CoMotionError(
      `類別數必須介於 ${CHART_MIN_CATEGORIES} 到 ${CHART_MAX_CATEGORIES} 之間（收到：${model.categories.length}）`,
    );
  }
  if (model.categories.some((category) => category === "")) {
    throw new CoMotionError("類別名稱不可為空字串");
  }

  if (model.series.length < CHART_MIN_SERIES || model.series.length > CHART_MAX_SERIES) {
    throw new CoMotionError(
      `系列數必須介於 ${CHART_MIN_SERIES} 到 ${CHART_MAX_SERIES} 之間（收到：${model.series.length}）`,
    );
  }

  const seenNames = new Set<string>();
  for (const series of model.series) {
    if (series.name === "") {
      throw new CoMotionError("系列名稱不可為空字串");
    }
    if (seenNames.has(series.name)) {
      throw new CoMotionError(`系列名稱重複：${series.name}`);
    }
    seenNames.add(series.name);

    if (series.values.length !== model.categories.length) {
      throw new CoMotionError(
        `系列「${series.name}」的值數（${series.values.length}）與類別數（${model.categories.length}）不符`,
      );
    }
    requireFiniteNumbers(series.values, `系列「${series.name}」`);

    requireEnum(series.axis, ["left", "right"], `系列「${series.name}」的 axis`);
    if (series.axis === "right" && model.axes === "single") {
      throw new CoMotionError(`系列「${series.name}」指定 axis="right"，但圖表 axes 是 single`);
    }
    if (series.color !== null && !HEX_COLOR.test(series.color)) {
      throw new CoMotionError(`系列「${series.name}」的顏色不是合法的 #RGB 或 #RRGGBB：${series.color}`);
    }
  }

  if (model.stacked) {
    if (!CHART_STACKABLE_TYPES.includes(model.type)) {
      throw new CoMotionError(`type=${model.type} 不支援堆疊，只有 ${CHART_STACKABLE_TYPES.join("、")} 可以`);
    }
    if (model.axes !== "single") {
      throw new CoMotionError("堆疊圖表必須是 axes=single");
    }
  }

  if ((model.type === "pie" || model.type === "donut") && model.axes !== "single") {
    throw new CoMotionError(`type=${model.type} 必須是 axes=single`);
  }
}

/** Locates a chart's container `<g>` by id (`requireContainer`'s chart-specific counterpart in `element-edit.ts`). */
export function requireChartContainer(svgContent: string, elementId: string): ScannedNode {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  const found = findChartContainer(svgRoot, elementId);
  if (!found) {
    throw new CoMotionError(`找不到元素：${elementId}`);
  }
  if (attributeValue(found, "data-comot-type") !== CHART_CONTAINER_TYPE) {
    throw new CoMotionError(`元素 ${elementId} 不是圖表`);
  }
  return found;
}

function findChartContainer(parent: ScannedNode, id: string): ScannedNode | undefined {
  for (const child of parent.children) {
    if (child.tag !== "g") continue;
    if (attributeValue(child, "id") === id) return child;
    const found = findChartContainer(child, id);
    if (found) return found;
  }
  return undefined;
}

function requireDataNode(container: ScannedNode, elementId: string): ScannedNode {
  const chartNode = container.children.find((child) => child.tag === "comot:chart");
  if (!chartNode) {
    throw new CoMotionError(`元素 ${elementId} 缺少 <comot:chart>`);
  }
  return chartNode;
}

function readNumberAttr(node: ScannedNode, name: string, elementId: string): number {
  const raw = attributeOf(node, name);
  if (!raw) {
    throw new CoMotionError(`元素 ${elementId} 的 <comot:chart> 缺少屬性：${name}`);
  }
  const value = Number(raw.value);
  if (!Number.isFinite(value)) {
    throw new CoMotionError(`元素 ${elementId} 的 <comot:chart> 屬性 ${name} 不是有限數字：${raw.value}`);
  }
  return value;
}

function readRequiredAttr(node: ScannedNode, name: string, elementId: string): string {
  const raw = attributeOf(node, name);
  if (!raw) {
    throw new CoMotionError(`元素 ${elementId} 的 <comot:chart> 缺少屬性：${name}`);
  }
  return raw.value;
}

function parseValues(raw: string, elementId: string, seriesName: string): number[] {
  return raw.split(",").map((token, index) => {
    const value = Number(token);
    if (token.trim() === "" || !Number.isFinite(value)) {
      throw new CoMotionError(
        `元素 ${elementId} 的系列「${seriesName}」第 ${index + 1} 個值不是有限數字：${token}`,
      );
    }
    return value;
  });
}

/**
 * Reads `elementId`'s `<comot:chart>` back into a `ChartModel`. Structural
 * legality (exactly one `<comot:chart>` and one `<svg>`) was already
 * checked by `assertSlideCompliant`/`checkSlideCompliance` — this only
 * reads content. Tolerates `axes="single"` documents where a stray series
 * still carries `axis="right"` (a hand-edited or pre-migration file, plan
 * §4.4 "合法但奇怪") by rendering that series against the left axis; it
 * does not tolerate anything `validateChartModel` would reject for a
 * FRESH write (missing attributes, non-finite numbers, count mismatches).
 */
export function readChartModel(svgContent: string, elementId: string): ChartModel {
  const container = requireChartContainer(svgContent, elementId);
  const chartNode = requireDataNode(container, elementId);

  const type = requireEnum(readRequiredAttr(chartNode, "type", elementId), CHART_TYPES, "type");
  const stackedRaw = readRequiredAttr(chartNode, "stacked", elementId);
  if (stackedRaw !== "true" && stackedRaw !== "false") {
    throw new CoMotionError(`元素 ${elementId} 的 stacked 必須是 true 或 false：${stackedRaw}`);
  }
  const axes = requireEnum(readRequiredAttr(chartNode, "axes", elementId), ["single", "dual"], "axes");
  const palette = requireEnum(readRequiredAttr(chartNode, "palette", elementId), CHART_PALETTES, "palette");
  const legend = requireEnum(readRequiredAttr(chartNode, "legend", elementId), CHART_LEGENDS, "legend");
  const gridRaw = readRequiredAttr(chartNode, "grid", elementId);
  const labelsRaw = readRequiredAttr(chartNode, "labels", elementId);
  if (gridRaw !== "true" && gridRaw !== "false") {
    throw new CoMotionError(`元素 ${elementId} 的 grid 必須是 true 或 false：${gridRaw}`);
  }
  if (labelsRaw !== "true" && labelsRaw !== "false") {
    throw new CoMotionError(`元素 ${elementId} 的 labels 必須是 true 或 false：${labelsRaw}`);
  }
  const xTitle = attributeOf(chartNode, "x-title")?.value ?? "";
  const yTitle = attributeOf(chartNode, "y-title")?.value ?? "";
  const width = readNumberAttr(chartNode, "width", elementId);
  const height = readNumberAttr(chartNode, "height", elementId);

  const seriesNodes = chartNode.children.filter((child) => child.tag === "comot:series");
  const categoriesNodes = chartNode.children.filter((child) => child.tag === "comot:categories");
  if (seriesNodes.length === 0) {
    throw new CoMotionError(`元素 ${elementId} 的圖表沒有任何 <comot:series>`);
  }
  if (categoriesNodes.length !== 1) {
    throw new CoMotionError(`元素 ${elementId} 的圖表必須恰好有一個 <comot:categories>`);
  }
  const otherChildren = chartNode.children.filter(
    (child) => child.tag !== "comot:series" && child.tag !== "comot:categories",
  );
  if (otherChildren.length > 0) {
    throw new CoMotionError(`元素 ${elementId} 的 <comot:chart> 含有未知子元素：<${otherChildren[0].tag}>`);
  }

  const categories = readRequiredAttr(categoriesNodes[0], "values", elementId)
    .split(",")
    .map((token) => token);
  if (categories.some((category) => category === "")) {
    throw new CoMotionError(`元素 ${elementId} 的類別清單不可含空字串`);
  }

  const series: ChartSeries[] = seriesNodes.map((node) => {
    const name = readRequiredAttr(node, "name", elementId);
    const values = parseValues(readRequiredAttr(node, "values", elementId), elementId, name);
    const axisRaw = attributeOf(node, "axis")?.value ?? "left";
    const axis = requireEnum(axisRaw, ["left", "right"], `系列「${name}」的 axis`);
    const colorRaw = attributeOf(node, "color")?.value ?? null;
    return { name, values, axis, color: colorRaw };
  });

  const model: ChartModel = {
    type,
    stacked: stackedRaw === "true",
    axes,
    palette,
    legend,
    grid: gridRaw === "true",
    labels: labelsRaw === "true",
    xTitle,
    yTitle,
    width,
    height,
    series,
    categories,
  };

  // Structural read only above; re-validate everything a write would
  // check EXCEPT the strict single-axis-implies-no-right-series rule
  // (plan §4.4 "合法但奇怪" — a stray legacy `axis="right"` under
  // `axes="single"` is tolerated on read, treated as "left" by the
  // renderer, see `chart/render.ts`).
  const forValidation: ChartModel = {
    ...model,
    series: model.series.map((s) => (model.axes === "single" ? { ...s, axis: "left" as const } : s)),
  };
  validateChartModel(forValidation);

  return model;
}

/** Serializes `model` back into `<comot:chart>…</comot:chart>`, attribute order fixed (plan §4.1). */
export function serializeChartData(model: ChartModel): string {
  const attrs = [
    `xmlns:comot="${CHART_NS}"`,
    `type="${model.type}"`,
    `stacked="${model.stacked}"`,
    `axes="${model.axes}"`,
    `palette="${model.palette}"`,
    `legend="${model.legend}"`,
    `grid="${model.grid}"`,
    `labels="${model.labels}"`,
    `x-title="${escapeXmlAttr(model.xTitle)}"`,
    `y-title="${escapeXmlAttr(model.yTitle)}"`,
    `width="${formatSvgNumber(model.width)}"`,
    `height="${formatSvgNumber(model.height)}"`,
  ].join(" ");

  const seriesMarkup = model.series
    .map((series) => {
      const values = series.values.map((value) => formatSvgNumber(value)).join(",");
      const colorAttr = series.color !== null ? ` color="${escapeXmlAttr(series.color)}"` : "";
      return `<comot:series name="${escapeXmlAttr(series.name)}" values="${values}" axis="${series.axis}"${colorAttr}/>`;
    })
    .join("");

  const categoriesMarkup = `<comot:categories values="${model.categories.map((c) => escapeXmlAttr(c)).join(",")}"/>`;

  return `<comot:chart ${attrs}>${seriesMarkup}${categoriesMarkup}</comot:chart>`;
}
