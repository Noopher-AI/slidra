import { useState } from "react";
import type { CanvasController } from "../../../canvas.js";
import {
  CHART_CREATE_MAX_CATEGORIES,
  CHART_CREATE_MAX_SERIES,
  CHART_MIN_CATEGORIES,
  CHART_MIN_SERIES,
  CHART_PALETTES,
  CHART_TYPES,
  type ChartPalette,
  type ChartType,
} from "../../../chart-model.js";

export interface ChartPanelProps {
  onClose(): void;
  controller: CanvasController | null;
  /** [E2.T7] 既有的 slidePath 傳遞方式（Dock.tsx 已經給 AnimatePanel 用同一個 prop）——`chart create` 需要知道要插進哪張投影片。 */
  slidePath: string | null;
}

const TYPE_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  hbar: "H-Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  donut: "Donut",
};

const DEFAULT_TYPE: ChartType = "bar";
const DEFAULT_SERIES = 1;
const DEFAULT_CATEGORIES = 6;
const DEFAULT_PALETTE: ChartPalette = "brand";

/**
 * Chart 插入面板 (E2.T12 plan §4.2/AC-1)：類型（6 種）、系列數（1–4）、類別數
 * （2–12）、調色盤（3 組），按 Insert 送出 `chart create`——樣本資料由 core
 * 端的確定性公式填入（`createChartElement`），這裡只送使用者選的四個值。
 */
export function ChartPanel({ onClose, controller, slidePath }: ChartPanelProps) {
  const [type, setType] = useState<ChartType>(DEFAULT_TYPE);
  const [seriesCount, setSeriesCount] = useState(DEFAULT_SERIES);
  const [categoriesCount, setCategoriesCount] = useState(DEFAULT_CATEGORIES);
  const [palette, setPalette] = useState<ChartPalette>(DEFAULT_PALETTE);

  const canInsert = controller !== null && slidePath !== null;

  async function insert(): Promise<void> {
    if (!canInsert) return;
    await controller!.runCommand("chart create", {
      slidePath,
      type,
      seriesCount,
      categoriesCount,
      palette,
    });
    onClose();
  }

  return (
    <div className="floating-layer dock-panel chart-panel" role="dialog" aria-label="Chart">
      <div className="chart-panel-types" role="group" aria-label="Chart type">
        {CHART_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className="chart-panel-type"
            data-type={t}
            aria-pressed={type === t}
            onClick={() => setType(t)}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="chart-panel-row">
        <label className="chart-panel-stepper">
          <span>Series</span>
          <div className="chart-panel-stepper-control">
            <button
              type="button"
              aria-label="Decrease series count"
              disabled={seriesCount <= CHART_MIN_SERIES}
              onClick={() => setSeriesCount((n) => Math.max(CHART_MIN_SERIES, n - 1))}
            >
              −
            </button>
            <span aria-live="polite">{seriesCount}</span>
            <button
              type="button"
              aria-label="Increase series count"
              disabled={seriesCount >= CHART_CREATE_MAX_SERIES}
              onClick={() => setSeriesCount((n) => Math.min(CHART_CREATE_MAX_SERIES, n + 1))}
            >
              +
            </button>
          </div>
        </label>
        <label className="chart-panel-stepper">
          <span>Categories</span>
          <div className="chart-panel-stepper-control">
            <button
              type="button"
              aria-label="Decrease category count"
              disabled={categoriesCount <= CHART_MIN_CATEGORIES}
              onClick={() => setCategoriesCount((n) => Math.max(CHART_MIN_CATEGORIES, n - 1))}
            >
              −
            </button>
            <span aria-live="polite">{categoriesCount}</span>
            <button
              type="button"
              aria-label="Increase category count"
              disabled={categoriesCount >= CHART_CREATE_MAX_CATEGORIES}
              onClick={() => setCategoriesCount((n) => Math.min(CHART_CREATE_MAX_CATEGORIES, n + 1))}
            >
              +
            </button>
          </div>
        </label>
        <div className="chart-panel-palettes" role="group" aria-label="Palette">
          {CHART_PALETTES.map((p) => (
            <button
              key={p}
              type="button"
              className="chart-panel-palette"
              data-palette={p}
              aria-pressed={palette === p}
              aria-label={p}
              onClick={() => setPalette(p)}
            >
              <span className="chart-panel-palette-swatch" data-index="1" />
              <span className="chart-panel-palette-swatch" data-index="2" />
              <span className="chart-panel-palette-swatch" data-index="3" />
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="chart-panel-insert" disabled={!canInsert} onClick={() => void insert()}>
        Insert
      </button>
    </div>
  );
}
