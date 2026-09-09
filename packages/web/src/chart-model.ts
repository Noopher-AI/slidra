/**
 * Reads a `<comot:chart>` container back into a `ChartModel` with the
 * browser's own `DOMParser` — the web's own copy of
 * core's chart module types/constants and `readChartModel` (F8,
 * NOOP-289). `renderChartSvg`/`validateChartModel`/chart editing are NOT
 * ported: the local chart preview is gone (decision in the plan — the
 * canvas no longer renders a chart preview of its own, it waits for the
 * server's SSE reload), so nothing here ever needs to produce a chart
 * SVG or reject a model before writing it.
 */

export type ChartType = "bar" | "hbar" | "line" | "area" | "pie" | "donut";
export type ChartPalette = "brand" | "cool" | "warm";
export type ChartLegend = "none" | "bottom" | "right";
export type ChartAxesMode = "single" | "dual";
export type ChartSeriesAxis = "left" | "right";

export const CHART_TYPES: readonly ChartType[] = ["bar", "hbar", "line", "area", "pie", "donut"];
export const CHART_PALETTES: readonly ChartPalette[] = ["brand", "cool", "warm"];
export const CHART_LEGENDS: readonly ChartLegend[] = ["none", "bottom", "right"];
export const CHART_STACKABLE_TYPES: readonly ChartType[] = ["bar", "hbar", "area"];

export const CHART_MIN_CATEGORIES = 2;
export const CHART_MAX_CATEGORIES = 60;
export const CHART_MIN_SERIES = 1;
export const CHART_MAX_SERIES = 12;
/** `chart create`'s own, tighter caps (原型插入面板的邊界). */
export const CHART_CREATE_MAX_SERIES = 4;
export const CHART_CREATE_MAX_CATEGORIES = 12;

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

function requireEnum<T extends string>(value: string, domain: readonly T[], label: string): T {
  if (!(domain as readonly string[]).includes(value)) {
    throw new Error(`${label} 必須是下列其中之一：${domain.join("、")}（收到：${value}）`);
  }
  return value as T;
}

function localName(el: Element): string {
  return el.localName.toLowerCase();
}

function findChartContainer(root: Element, id: string): Element | null {
  for (const child of Array.from(root.children)) {
    if (localName(child) !== "g") continue;
    if (child.getAttribute("id") === id) return child;
    const found = findChartContainer(child, id);
    if (found) return found;
  }
  return null;
}

function requireChartContainer(doc: Document, elementId: string): Element {
  const svgRoot = doc.documentElement;
  if (!svgRoot || localName(svgRoot) !== "svg") throw new Error("投影片的根節點不是 <svg>");
  const found = findChartContainer(svgRoot, elementId);
  if (!found) throw new Error(`找不到元素：${elementId}`);
  if (found.getAttribute("data-comot-type") !== "chart") throw new Error(`元素 ${elementId} 不是圖表`);
  return found;
}

function requireDataNode(container: Element, elementId: string): Element {
  const chartNode = Array.from(container.children).find((child) => localName(child) === "chart");
  if (!chartNode) throw new Error(`元素 ${elementId} 缺少 <comot:chart>`);
  return chartNode;
}

function readRequiredAttr(node: Element, name: string, elementId: string): string {
  const raw = node.getAttribute(name);
  if (raw === null) throw new Error(`元素 ${elementId} 的 <comot:chart> 缺少屬性：${name}`);
  return raw;
}

function readNumberAttr(node: Element, name: string, elementId: string): number {
  const raw = readRequiredAttr(node, name, elementId);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`元素 ${elementId} 的 <comot:chart> 屬性 ${name} 不是有限數字：${raw}`);
  return value;
}

function parseValues(raw: string, elementId: string, seriesName: string): number[] {
  return raw.split(",").map((token, index) => {
    const value = Number(token);
    if (token.trim() === "" || !Number.isFinite(value)) {
      throw new Error(`元素 ${elementId} 的系列「${seriesName}」第 ${index + 1} 個值不是有限數字：${token}`);
    }
    return value;
  });
}

/**
 * Reads `elementId`'s `<comot:chart>` back into a `ChartModel`, parsing
 * `svgContent` with `DOMParser`. Tolerates `axes="single"` documents where
 * a stray series still carries `axis="right"` (a hand-edited or
 * pre-migration file) by leaving it as read — the browser does not
 * re-validate a model it only ever displays, unlike core's write-time
 * `readChartModel` which re-runs `validateChartModel`.
 */
export function readChartModel(svgContent: string, elementId: string): ChartModel {
  const doc = new DOMParser().parseFromString(svgContent, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("投影片的 SVG 標記無法解析");
  }
  const container = requireChartContainer(doc, elementId);
  const chartNode = requireDataNode(container, elementId);

  const type = requireEnum(readRequiredAttr(chartNode, "type", elementId), CHART_TYPES, "type");
  const stackedRaw = readRequiredAttr(chartNode, "stacked", elementId);
  if (stackedRaw !== "true" && stackedRaw !== "false") {
    throw new Error(`元素 ${elementId} 的 stacked 必須是 true 或 false：${stackedRaw}`);
  }
  const axes = requireEnum(readRequiredAttr(chartNode, "axes", elementId), ["single", "dual"] as const, "axes");
  const palette = requireEnum(readRequiredAttr(chartNode, "palette", elementId), CHART_PALETTES, "palette");
  const legend = requireEnum(readRequiredAttr(chartNode, "legend", elementId), CHART_LEGENDS, "legend");
  const gridRaw = readRequiredAttr(chartNode, "grid", elementId);
  const labelsRaw = readRequiredAttr(chartNode, "labels", elementId);
  if (gridRaw !== "true" && gridRaw !== "false") throw new Error(`元素 ${elementId} 的 grid 必須是 true 或 false：${gridRaw}`);
  if (labelsRaw !== "true" && labelsRaw !== "false") throw new Error(`元素 ${elementId} 的 labels 必須是 true 或 false：${labelsRaw}`);
  const xTitle = chartNode.getAttribute("x-title") ?? "";
  const yTitle = chartNode.getAttribute("y-title") ?? "";
  const width = readNumberAttr(chartNode, "width", elementId);
  const height = readNumberAttr(chartNode, "height", elementId);

  const children = Array.from(chartNode.children);
  const seriesNodes = children.filter((child) => localName(child) === "series");
  const categoriesNodes = children.filter((child) => localName(child) === "categories");
  if (seriesNodes.length === 0) throw new Error(`元素 ${elementId} 的圖表沒有任何 <comot:series>`);
  if (categoriesNodes.length !== 1) throw new Error(`元素 ${elementId} 的圖表必須恰好有一個 <comot:categories>`);

  const categories = readRequiredAttr(categoriesNodes[0], "values", elementId).split(",");
  if (categories.some((category) => category === "")) {
    throw new Error(`元素 ${elementId} 的類別清單不可含空字串`);
  }

  const series: ChartSeries[] = seriesNodes.map((node) => {
    const name = readRequiredAttr(node, "name", elementId);
    const values = parseValues(readRequiredAttr(node, "values", elementId), elementId, name);
    const axisRaw = node.getAttribute("axis") ?? "left";
    const axis = requireEnum(axisRaw, ["left", "right"] as const, `系列「${name}」的 axis`);
    const color = node.getAttribute("color");
    return { name, values, axis, color };
  });

  return {
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
}
