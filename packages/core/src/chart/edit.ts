import { CoMotionError } from "../errors.js";
import { assertSlideCompliant } from "../slide/format.js";
import { attributeValue, scanDocument } from "../slide/scan.js";
import { applySplices, type Splice } from "../element-text.js";
import { formatSvgNumber } from "../svg-number.js";
import {
  CHART_CREATE_MAX_CATEGORIES,
  CHART_CREATE_MAX_SERIES,
  CHART_PALETTES,
  CHART_TYPES,
  readChartModel,
  requireChartContainer,
  serializeChartData,
  validateChartModel,
  type ChartAxesMode,
  type ChartLegend,
  type ChartModel,
  type ChartPalette,
  type ChartSeries,
  type ChartType,
} from "./model.js";
import { renderChartSvg } from "./render.js";

/**
 * The container-level splice writers for the `chart` command family (plan
 * §4.2), modeled on `effects/edit.ts`: every command re-derives the FULL
 * `ChartModel` (`readChartModel`), applies one patch, re-validates the
 * WHOLE result (`validateChartModel` — never just the touched field, since
 * cross-field rules like "stacked requires axes=single" can be broken by a
 * change to either field), then re-renders and splices both the data
 * element and the embedded `<svg>` back in. "GUI 永遠不直接改渲染結果"
 * (plan §4.2) — this module is the only writer of the `<svg>` half.
 */

function readViewBox(svgContent: string): { width: number; height: number } {
  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  const raw = attributeValue(svgRoot, "viewBox");
  if (!raw) {
    throw new CoMotionError("投影片缺少 viewBox");
  }
  const parts = raw
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new CoMotionError(`投影片的 viewBox 不是四個數字：${raw}`);
  }
  return { width: parts[2], height: parts[3] };
}

export interface CreateChartInput {
  type?: ChartType;
  seriesCount?: number;
  categoriesCount?: number;
  palette?: ChartPalette;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** `chart create` — sample data from the prototype's deterministic formula (plan §3.9), so a screenshot baseline stays stable. */
export function createChartElement(
  svgContent: string,
  slidePath: string,
  elementId: string,
  input: CreateChartInput,
): string {
  assertSlideCompliant(svgContent, slidePath);
  const { width: canvasWidth, height: canvasHeight } = readViewBox(svgContent);

  const type = input.type ?? "bar";
  if (!CHART_TYPES.includes(type)) {
    throw new CoMotionError(`chart create 不支援的 type：${type}`);
  }
  const seriesCount = input.seriesCount ?? 1;
  if (!Number.isInteger(seriesCount) || seriesCount < 1 || seriesCount > CHART_CREATE_MAX_SERIES) {
    throw new CoMotionError(
      `chart create 的 --series 必須介於 1 到 ${CHART_CREATE_MAX_SERIES} 之間（收到：${seriesCount}）`,
    );
  }
  const categoriesCount = input.categoriesCount ?? 6;
  if (
    !Number.isInteger(categoriesCount) ||
    categoriesCount < 2 ||
    categoriesCount > CHART_CREATE_MAX_CATEGORIES
  ) {
    throw new CoMotionError(
      `chart create 的 --categories 必須介於 2 到 ${CHART_CREATE_MAX_CATEGORIES} 之間，` +
        `超過請用 chart create 建立後再用 chart data set 給更多資料（收到：${categoriesCount}）`,
    );
  }
  const palette = input.palette ?? "brand";
  if (!CHART_PALETTES.includes(palette)) {
    throw new CoMotionError(`chart create 不支援的 palette：${palette}`);
  }

  const x = input.x ?? canvasWidth * 0.54;
  const y = input.y ?? canvasHeight * 0.16;
  const width = input.width ?? canvasWidth * 0.38;
  const height = input.height ?? canvasHeight * 0.66;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CoMotionError("--x/--y 必須是有限數字");
  }
  if (!Number.isFinite(width) || !(width > 0)) {
    throw new CoMotionError("--width 必須是大於 0 的有限數字");
  }
  if (!Number.isFinite(height) || !(height > 0)) {
    throw new CoMotionError("--height 必須是大於 0 的有限數字");
  }

  const categories = Array.from({ length: categoriesCount }, (_, j) => `C${j + 1}`);
  const series: ChartSeries[] = Array.from({ length: seriesCount }, (_, i) => ({
    name: `Series ${i + 1}`,
    values: categories.map((_, j) => Math.round(30 + 60 * Math.abs(Math.sin(j * 1.3 + i)))),
    axis: "left",
    color: null,
  }));

  const model: ChartModel = {
    type,
    stacked: false,
    axes: "single",
    palette,
    legend: "bottom",
    grid: true,
    labels: true,
    xTitle: "",
    yTitle: "",
    width,
    height,
    series,
    categories,
  };
  validateChartModel(model);

  const markup =
    `<g id="${elementId}" data-comot-type="chart" transform="translate(${formatSvgNumber(x)} ${formatSvgNumber(y)})">` +
    serializeChartData(model) +
    renderChartSvg(model) +
    `</g>`;

  const roots = scanDocument(svgContent);
  const svgRoot = roots.find((node) => node.tag === "svg")!;
  return svgContent.slice(0, svgRoot.contentEnd) + markup + svgContent.slice(svgRoot.contentEnd);
}

function updateChartElement(
  svgContent: string,
  slidePath: string,
  elementId: string,
  mutate: (model: ChartModel) => ChartModel,
): string {
  assertSlideCompliant(svgContent, slidePath);
  return spliceChartElement(svgContent, elementId, mutate);
}

/**
 * `element scale`/`element resize` on a chart container: the chart is
 * re-rendered at `width*sx`/`height*sy` (the model owns its size — a
 * `scale()` on the container transform would blur text and desync the
 * declared width/height from what is drawn). Compliance is the caller's
 * job, exactly like every other leaf write in `element-edit.ts`.
 */
export function scaleChartElement(svgContent: string, elementId: string, sx: number, sy: number): string {
  return spliceChartElement(svgContent, elementId, (model) => ({
    ...model,
    width: model.width * sx,
    height: model.height * sy,
  }));
}

function spliceChartElement(
  svgContent: string,
  elementId: string,
  mutate: (model: ChartModel) => ChartModel,
): string {
  const current = readChartModel(svgContent, elementId);
  const next = mutate(current);
  validateChartModel(next);

  const container = requireChartContainer(svgContent, elementId);
  const chartNode = container.children.find((child) => child.tag === "comot:chart")!;
  const svgNode = container.children.find((child) => child.tag === "svg")!;

  // Highest offset first isn't required here (applySplices already sorts),
  // but the two ranges never overlap regardless of write order.
  const splices: Splice[] = [
    { start: chartNode.start, end: chartNode.end, text: serializeChartData(next) },
    { start: svgNode.start, end: svgNode.end, text: renderChartSvg(next) },
  ];
  return applySplices(svgContent, splices);
}

export interface SetChartDataInput {
  categories: string[];
  series: { name: string; values: number[] }[];
}

/** `chart data set` — a wholesale replace; an existing series' `axis`/`color` carries over by name, a new name gets the defaults (plan §4.2). */
export function setChartData(
  svgContent: string,
  slidePath: string,
  elementId: string,
  input: SetChartDataInput,
): string {
  if (input.categories.length === 0) {
    throw new CoMotionError("類別清單不可為空");
  }
  if (input.series.length === 0) {
    throw new CoMotionError("圖表不能沒有系列");
  }
  return updateChartElement(svgContent, slidePath, elementId, (current) => {
    const existingByName = new Map(current.series.map((series) => [series.name, series]));
    const nextSeries: ChartSeries[] = input.series.map((series) => {
      if (series.name === "") {
        throw new CoMotionError("系列名稱不可為空字串");
      }
      if (series.values.length === 0) {
        throw new CoMotionError(`系列「${series.name}」不可沒有任何值`);
      }
      const existing = existingByName.get(series.name);
      return {
        name: series.name,
        values: series.values,
        axis: existing?.axis ?? "left",
        color: existing?.color ?? null,
      };
    });
    return { ...current, categories: input.categories, series: nextSeries };
  });
}

/** `chart type set` — switching to pie/donut while stacked or dual is left for `validateChartModel` to reject (plan: "不自動改"). */
export function setChartType(svgContent: string, slidePath: string, elementId: string, type: ChartType): string {
  if (!CHART_TYPES.includes(type)) {
    throw new CoMotionError(`不支援的 type：${type}`);
  }
  return updateChartElement(svgContent, slidePath, elementId, (current) => ({ ...current, type }));
}

/** `chart palette set` — `colorOverrides` only touches the series named in it; every other series keeps its current colour (`null` or a prior explicit colour) untouched. */
export function setChartPalette(
  svgContent: string,
  slidePath: string,
  elementId: string,
  palette: ChartPalette,
  colorOverrides: ReadonlyMap<string, string>,
): string {
  if (!CHART_PALETTES.includes(palette)) {
    throw new CoMotionError(`不支援的 palette：${palette}`);
  }
  return updateChartElement(svgContent, slidePath, elementId, (current) => {
    const names = new Set(current.series.map((series) => series.name));
    for (const name of colorOverrides.keys()) {
      if (!names.has(name)) {
        throw new CoMotionError(`找不到系列：${name}`);
      }
    }
    return {
      ...current,
      palette,
      series: current.series.map((series) => ({
        ...series,
        color: colorOverrides.get(series.name) ?? series.color,
      })),
    };
  });
}

/** `chart axis set` — a full replace of every series' axis assignment (plan §4.2), not an incremental patch. */
export function setChartAxis(
  svgContent: string,
  slidePath: string,
  elementId: string,
  axes: ChartAxesMode,
  rightSeriesNames: readonly string[],
): string {
  if (axes !== "single" && axes !== "dual") {
    throw new CoMotionError(`不支援的 axes：${axes}`);
  }
  return updateChartElement(svgContent, slidePath, elementId, (current) => {
    if (axes === "single") {
      if (rightSeriesNames.length > 0) {
        throw new CoMotionError("axes=single 不可指定 --right");
      }
      return { ...current, axes, series: current.series.map((series) => ({ ...series, axis: "left" })) };
    }
    if (rightSeriesNames.length === 0) {
      throw new CoMotionError("axes=dual 必須用 --right 指定至少一個系列，否則等同 single");
    }
    const names = new Set(current.series.map((series) => series.name));
    for (const name of rightSeriesNames) {
      if (!names.has(name)) {
        throw new CoMotionError(`找不到系列：${name}`);
      }
    }
    const rightSet = new Set(rightSeriesNames);
    return {
      ...current,
      axes,
      series: current.series.map((series) => ({
        ...series,
        axis: rightSet.has(series.name) ? "right" : "left",
      })),
    };
  });
}

/** `chart stack set` — the type/axes cross-checks are `validateChartModel`'s, not duplicated here. */
export function setChartStack(svgContent: string, slidePath: string, elementId: string, stacked: boolean): string {
  return updateChartElement(svgContent, slidePath, elementId, (current) => ({ ...current, stacked }));
}

/** `chart legend set`. */
export function setChartLegend(
  svgContent: string,
  slidePath: string,
  elementId: string,
  legend: ChartLegend,
): string {
  const legends: readonly ChartLegend[] = ["none", "bottom", "right"];
  if (!legends.includes(legend)) {
    throw new CoMotionError(`不支援的 legend：${legend}`);
  }
  return updateChartElement(svgContent, slidePath, elementId, (current) => ({ ...current, legend }));
}

export type ChartOptionKey = "grid" | "labels" | "x-title" | "y-title";

/** `chart option set` — the one command covering the four remaining display toggles (plan §0.1 G2). */
export function setChartOption(
  svgContent: string,
  slidePath: string,
  elementId: string,
  key: ChartOptionKey,
  value: string,
): string {
  return updateChartElement(svgContent, slidePath, elementId, (current) => {
    switch (key) {
      case "grid":
        if (value !== "true" && value !== "false") {
          throw new CoMotionError("grid 的值只能是 true 或 false");
        }
        return { ...current, grid: value === "true" };
      case "labels":
        if (value !== "true" && value !== "false") {
          throw new CoMotionError("labels 的值只能是 true 或 false");
        }
        return { ...current, labels: value === "true" };
      case "x-title":
        return { ...current, xTitle: value };
      case "y-title":
        return { ...current, yTitle: value };
      default:
        throw new CoMotionError(`不支援的 key：${key as string}`);
    }
  });
}
