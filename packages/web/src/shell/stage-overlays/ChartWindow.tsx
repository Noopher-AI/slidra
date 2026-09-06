import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { CanvasController, ChartWindowState } from "../../canvas.js";
import {
  CHART_MAX_CATEGORIES,
  CHART_MAX_SERIES,
  CHART_MIN_CATEGORIES,
  CHART_MIN_SERIES,
  CHART_PALETTES,
  CHART_TYPES,
  validateChartModel,
  type ChartAxesMode,
  type ChartLegend,
  type ChartModel,
  type ChartPalette,
  type ChartSeries,
  type ChartType,
} from "@co-motion/core/chart";

export interface ChartWindowProps {
  /** `null` = closed (the caller does not mount this component at all in that case — see OverlayLayer.tsx). */
  state: ChartWindowState;
  controller: CanvasController | null;
  /** `.canvas-area`'s own size — drag is clamped to it (plan §3.9's `startWinDrag`, ported verbatim: `Math.max(0, Math.min(…, well.width - 60))`). */
  bounds: { width: number; height: number };
}

const TYPE_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  hbar: "H-Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  donut: "Donut",
};
const STACKABLE_TYPES: ReadonlySet<ChartType> = new Set(["bar", "hbar", "area"]);
const LEGEND_OPTIONS: { value: ChartLegend; label: string }[] = [
  { value: "none", label: "None" },
  { value: "bottom", label: "Bottom" },
  { value: "right", label: "Right" },
];

export interface EditableSeries {
  name: string;
  /** Kept as strings — an editable numeric field is not always a valid number mid-keystroke ("-", ""). */
  values: string[];
}

/**
 * "資料格 state → chart data set input" (plan §6.2, 比照 `TextPanel.tsx`'s
 * own `textPanelInsertInput`): a pure function so this conversion has a
 * unit test independent of React (this codebase's component tests are all
 * `renderToStaticMarkup`, see that file's own doc comment). `null` means
 * the draft is mid-edit and does not parse to a sendable payload YET (an
 * empty category/series name, a non-numeric or missing value) — the caller
 * neither previews nor commits in that case, exactly like a blank textarea
 * never sends `textbox add`.
 */
export function chartDataSetInputFromDraft(
  categories: readonly string[],
  series: readonly EditableSeries[],
): { categories: string[]; series: { name: string; values: number[] }[] } | null {
  if (categories.length === 0 || categories.some((c) => c === "")) return null;
  if (series.length === 0) return null;
  const parsed: { name: string; values: number[] }[] = [];
  for (const s of series) {
    if (s.name === "") return null;
    if (s.values.length !== categories.length) return null;
    // `Number("")` is 0, not NaN — treated here as "still typing, not a
    // number yet" rather than a legitimate zero, so clearing a field to
    // retype it never flashes a 0 into the preview/commit mid-edit.
    const values = s.values.map((v) => (v.trim() === "" ? NaN : Number(v)));
    if (values.some((v) => !Number.isFinite(v))) return null;
    parsed.push({ name: s.name, values });
  }
  return { categories: [...categories], series: parsed };
}

function uniqueSeriesName(existing: readonly { name: string }[]): string {
  for (let n = existing.length + 1; ; n++) {
    const candidate = `Series ${n}`;
    if (!existing.some((s) => s.name === candidate)) return candidate;
  }
}

/**
 * Chart 資料視窗 (E2.T12 plan §3.6/§4.5, AC-2/AC-3/AC-4/AC-5/AC-6): 雙擊圖表
 * 開啟（由 canvas.ts 的 `subscribeChartWindow` 驅動，本元件只在有 state 時被
 * 掛載）；拖曳標題列移動、位置夾制在 `.canvas-area` 之內；Esc 關閉，點視窗外
 * 不關（原型 `closeMenu` 的 Escape 分支特意把 `chartWin` 排除在外——編輯時
 * 要能一邊看著舞台）。每個控制都遵守同一條分界：資料格/軸標題用「本地預覽
 * ＋ blur 提交」，其餘一律「點擊當下提交」——分界表見 plan §4.5。
 */
export function ChartWindow({ state, controller, bounds }: ChartWindowProps) {
  const { model } = state;
  const [type, setType] = useState<ChartType>(model.type);
  const [stacked, setStacked] = useState(model.stacked);
  const [axes, setAxes] = useState<ChartAxesMode>(model.axes);
  const [rightNames, setRightNames] = useState<ReadonlySet<string>>(
    () => new Set(model.series.filter((s) => s.axis === "right").map((s) => s.name)),
  );
  const [palette, setPalette] = useState<ChartPalette>(model.palette);
  const [legend, setLegend] = useState<ChartLegend>(model.legend);
  const [grid, setGrid] = useState(model.grid);
  const [labels, setLabels] = useState(model.labels);
  const [xTitle, setXTitle] = useState(model.xTitle);
  const [yTitle, setYTitle] = useState(model.yTitle);
  const [categories, setCategories] = useState<string[]>(model.categories);
  const [seriesDraft, setSeriesDraft] = useState<EditableSeries[]>(() =>
    model.series.map((s) => ({ name: s.name, values: s.values.map(String) })),
  );

  // Default position: top-right of the well, minus a margin (prototype's
  // own `chartWinPos` default, comotion-logic-v3.js's `startWinDrag`) — one
  // `useState` initializer per mount, so a NEW chart window (a different
  // `state.id`, remounted via OverlayLayer's `key={state.id}`) always opens
  // at this corner rather than wherever the previous one was dragged to.
  const [pos, setPos] = useState(() => ({ left: Math.max(0, bounds.width - 436 - 16), top: 16 }));
  const dragRef = useRef<{ startX: number; startY: number; startLeft: number; startTop: number } | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") controller?.closeChartWindow();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  function buildModel(nextCategories: readonly string[], nextSeries: readonly EditableSeries[]): ChartModel | null {
    const data = chartDataSetInputFromDraft(nextCategories, nextSeries);
    if (!data) return null;
    const series: ChartSeries[] = data.series.map((s) => {
      const existing = model.series.find((orig) => orig.name === s.name);
      return {
        name: s.name,
        values: s.values,
        axis: axes === "dual" && rightNames.has(s.name) ? "right" : "left",
        color: existing?.color ?? null,
      };
    });
    const candidate: ChartModel = {
      type,
      stacked,
      axes,
      palette,
      legend,
      grid,
      labels,
      xTitle,
      yTitle,
      width: model.width,
      height: model.height,
      series,
      categories: [...nextCategories],
    };
    try {
      validateChartModel(candidate);
      return candidate;
    } catch {
      return null; // Mid-edit combination (e.g. dual axis toggled but no series marked right yet) — hold the last good preview rather than clearing the chart.
    }
  }

  // Local preview (plan §4.5: "本地預覽期間不寫任何檔案") — every controlled
  // field re-renders the embedded <svg> through the exact same
  // `renderChartSvg` the server uses, via `CanvasController.previewChart`.
  useEffect(() => {
    const candidate = buildModel(categories, seriesDraft);
    if (candidate) controller?.previewChart(state.id, candidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, stacked, axes, rightNames, palette, legend, grid, labels, xTitle, yTitle, categories, seriesDraft]);

  /** Sends `name`, reverting the given local field(s) back to the last-known-committed value on failure (plan §4.5: "把本地預覽還原成伺服器上的狀態") — a failed write never touches the file, so `model` (this render's closed-over `state.model`) IS that last-known-committed value. */
  async function commit(name: string, input: Record<string, unknown>, revert: () => void): Promise<void> {
    if (!controller) return;
    const result = await controller.runCommand(name, { slidePath: state.slidePath, elementId: state.id, ...input });
    if (!result.ok) revert();
  }

  function commitType(next: ChartType): void {
    setType(next);
    void commit("chart type set", { type: next }, () => setType(model.type));
  }
  function commitPalette(next: ChartPalette): void {
    setPalette(next);
    void commit("chart palette set", { palette: next, colors: [] }, () => setPalette(model.palette));
  }
  function commitLegend(next: ChartLegend): void {
    setLegend(next);
    void commit("chart legend set", { legend: next }, () => setLegend(model.legend));
  }
  function commitGrid(next: boolean): void {
    setGrid(next);
    void commit("chart option set", { key: "grid", value: String(next) }, () => setGrid(model.grid));
  }
  function commitLabels(next: boolean): void {
    setLabels(next);
    void commit("chart option set", { key: "labels", value: String(next) }, () => setLabels(model.labels));
  }
  function commitStack(next: boolean): void {
    setStacked(next);
    void commit("chart stack set", { stacked: next }, () => setStacked(model.stacked));
  }
  function commitAxis(nextAxes: ChartAxesMode, nextRight: ReadonlySet<string>): void {
    setAxes(nextAxes);
    setRightNames(nextRight);
    void commit("chart axis set", { axes: nextAxes, right: [...nextRight] }, () => {
      setAxes(model.axes);
      setRightNames(new Set(model.series.filter((s) => s.axis === "right").map((s) => s.name)));
    });
  }
  function commitTitle(key: "x-title" | "y-title"): void {
    const value = key === "x-title" ? xTitle : yTitle;
    void commit("chart option set", { key, value }, () => {
      if (key === "x-title") setXTitle(model.xTitle);
      else setYTitle(model.yTitle);
    });
  }
  function commitData(nextCategories: string[], nextSeries: EditableSeries[]): void {
    const data = chartDataSetInputFromDraft(nextCategories, nextSeries);
    if (!data) return; // Still mid-edit — nothing valid to send yet (matches TextPanel's "empty textarea never sends" posture).
    void commit("chart data set", { categories: data.categories, series: data.series }, () => {
      setCategories(model.categories);
      setSeriesDraft(model.series.map((s) => ({ name: s.name, values: s.values.map(String) })));
    });
  }

  function toggleAxes(): void {
    const next: ChartAxesMode = axes === "single" ? "dual" : "single";
    // Switching to single must clear the right-axis set — `chart axis set`
    // rejects `axes=single` combined with any `--right` name (core's own
    // "that would just mean single" guard).
    const nextRight =
      next === "single"
        ? new Set<string>()
        : rightNames.size === 0 && seriesDraft.length > 0
          ? new Set([seriesDraft[seriesDraft.length - 1].name])
          : rightNames;
    commitAxis(next, nextRight);
  }
  function toggleSeriesRight(name: string): void {
    const next = new Set(rightNames);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    commitAxis(axes, next);
  }

  function updateCategory(index: number, value: string): void {
    setCategories((current) => current.map((c, i) => (i === index ? value : c)));
  }
  function updateValue(seriesIndex: number, valueIndex: number, value: string): void {
    setSeriesDraft((current) =>
      current.map((s, i) =>
        i === seriesIndex ? { ...s, values: s.values.map((v, vi) => (vi === valueIndex ? value : v)) } : s,
      ),
    );
  }
  function updateSeriesName(index: number, value: string): void {
    setSeriesDraft((current) => current.map((s, i) => (i === index ? { ...s, name: value } : s)));
  }

  function addRow(): void {
    const nextCategories = [...categories, `C${categories.length + 1}`];
    const nextSeries = seriesDraft.map((s) => ({ ...s, values: [...s.values, "0"] }));
    setCategories(nextCategories);
    setSeriesDraft(nextSeries);
    commitData(nextCategories, nextSeries);
  }
  function removeRow(index: number): void {
    if (categories.length <= CHART_MIN_CATEGORIES) return;
    const nextCategories = categories.filter((_, i) => i !== index);
    const nextSeries = seriesDraft.map((s) => ({ ...s, values: s.values.filter((_, i) => i !== index) }));
    setCategories(nextCategories);
    setSeriesDraft(nextSeries);
    commitData(nextCategories, nextSeries);
  }
  function addSeries(): void {
    const nextSeries = [...seriesDraft, { name: uniqueSeriesName(seriesDraft), values: categories.map(() => "0") }];
    setSeriesDraft(nextSeries);
    commitData(categories, nextSeries);
  }
  function removeSeries(index: number): void {
    if (seriesDraft.length <= CHART_MIN_SERIES) return;
    const nextSeries = seriesDraft.filter((_, i) => i !== index);
    setSeriesDraft(nextSeries);
    commitData(categories, nextSeries);
  }

  function handleTitleBarMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startY: event.clientY, startLeft: pos.left, startTop: pos.top };
    function onMove(moveEvent: globalThis.MouseEvent): void {
      const drag = dragRef.current;
      if (!drag) return;
      const left = Math.max(0, Math.min(drag.startLeft + moveEvent.clientX - drag.startX, Math.max(0, bounds.width - 60)));
      const top = Math.max(0, Math.min(drag.startTop + moveEvent.clientY - drag.startY, Math.max(0, bounds.height - 40)));
      setPos({ left, top });
    }
    function onUp(): void {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const isPie = type === "pie" || type === "donut";

  return (
    <div className="chart-window" role="dialog" aria-label="Chart data" style={{ left: pos.left, top: pos.top }}>
      <div className="chart-window-titlebar" onMouseDown={handleTitleBarMouseDown}>
        <span className="chart-window-title">Chart data</span>
        <button type="button" className="chart-window-close" aria-label="Close" onClick={() => controller?.closeChartWindow()}>
          ✕
        </button>
      </div>
      <div className="chart-window-body">
        <div className="chart-window-types" role="group" aria-label="Chart type">
          {CHART_TYPES.map((t) => (
            <button key={t} type="button" aria-pressed={type === t} onClick={() => commitType(t)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>

        <table className="chart-window-table">
          <thead>
            <tr>
              <th>Category</th>
              {seriesDraft.map((s, si) => (
                <th key={si}>
                  <input
                    aria-label={`Series ${si + 1} name`}
                    value={s.name}
                    onChange={(event) => updateSeriesName(si, event.target.value)}
                    onBlur={() => commitData(categories, seriesDraft)}
                  />
                  {!isPie && (
                    <button
                      type="button"
                      aria-label={`Remove series ${s.name}`}
                      disabled={seriesDraft.length <= CHART_MIN_SERIES}
                      onClick={() => removeSeries(si)}
                    >
                      ✕
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((category, ci) => (
              <tr key={ci}>
                <td>
                  <input
                    aria-label={`Category ${ci + 1}`}
                    value={category}
                    onChange={(event) => updateCategory(ci, event.target.value)}
                    onBlur={() => commitData(categories, seriesDraft)}
                  />
                </td>
                {seriesDraft.map((s, si) => (
                  <td key={si}>
                    <input
                      type="number"
                      aria-label={`${s.name || `Series ${si + 1}`} at ${category || `category ${ci + 1}`}`}
                      value={s.values[ci]}
                      onChange={(event) => updateValue(si, ci, event.target.value)}
                      onBlur={() => commitData(categories, seriesDraft)}
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    aria-label={`Remove row ${category || ci + 1}`}
                    disabled={categories.length <= CHART_MIN_CATEGORIES}
                    onClick={() => removeRow(ci)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="chart-window-table-actions">
          <button type="button" disabled={categories.length >= CHART_MAX_CATEGORIES} onClick={addRow}>
            + Row
          </button>
          {isPie ? (
            <span className="chart-window-hint">Pie uses the first series</span>
          ) : (
            <button type="button" disabled={seriesDraft.length >= CHART_MAX_SERIES} onClick={addSeries}>
              + Series
            </button>
          )}
        </div>

        <div className="chart-window-options">
          <div className="chart-window-field">
            <span className="chart-window-field-label">Palette</span>
            <div className="chart-window-palettes" role="group" aria-label="Palette">
              {CHART_PALETTES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="chart-window-palette-swatch"
                  data-palette={p}
                  aria-pressed={palette === p}
                  aria-label={p}
                  onClick={() => commitPalette(p)}
                />
              ))}
            </div>
          </div>
          <div className="chart-window-field">
            <span className="chart-window-field-label">Legend</span>
            <div className="chart-window-legend" role="group" aria-label="Legend">
              {LEGEND_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={legend === option.value}
                  onClick={() => commitLegend(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="chart-window-toggle">
            <input type="checkbox" checked={grid} onChange={(event) => commitGrid(event.target.checked)} />
            Grid lines
          </label>
          <label className="chart-window-toggle">
            <input type="checkbox" checked={labels} onChange={(event) => commitLabels(event.target.checked)} />
            Value labels
          </label>
          {!isPie && (
            <label className="chart-window-toggle">
              <input
                type="checkbox"
                checked={stacked}
                disabled={!STACKABLE_TYPES.has(type)}
                onChange={(event) => commitStack(event.target.checked)}
              />
              Stacked
            </label>
          )}
          {!isPie && (
            <label className="chart-window-toggle">
              <input type="checkbox" checked={axes === "dual"} onChange={toggleAxes} />
              Dual axis
            </label>
          )}
          {!isPie && axes === "dual" && (
            <div className="chart-window-axis-assign" role="group" aria-label="Right axis series">
              {seriesDraft.map((s) => (
                <label key={s.name}>
                  <input type="checkbox" checked={rightNames.has(s.name)} onChange={() => toggleSeriesRight(s.name)} />
                  {s.name || "(unnamed)"} → right
                </label>
              ))}
            </div>
          )}
          {!isPie && (
            <label className="chart-window-title-input">
              X axis title
              <input value={xTitle} onChange={(event) => setXTitle(event.target.value)} onBlur={() => commitTitle("x-title")} />
            </label>
          )}
          {!isPie && (
            <label className="chart-window-title-input">
              Y axis title
              <input value={yTitle} onChange={(event) => setYTitle(event.target.value)} onBlur={() => commitTitle("y-title")} />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
