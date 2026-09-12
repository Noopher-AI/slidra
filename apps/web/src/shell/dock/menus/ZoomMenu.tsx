import { ZOOM_PRESETS, formatZoomPercent, setZoom, zoomFit, type ZoomPanState } from "../../stage-view.js";

export interface ZoomMenuProps {
  zoomPan: ZoomPanState;
  onChange(next: ZoomPanState): void;
  onClose(): void;
}

/**
 * 縮放選單 — 這張骨架票唯一要求「完全可用」的浮層（其餘 Dock 面板／選單都是
 * 空容器）。05-INTERACTIONS.feature「縮放選單」：− 百分比 + ｜Fit｜預設值，
 * 目前值以 `--brand-red` 標示；選 Fit 回到 100% 並置中。
 *
 * +/− 兩顆按鈕比照 comotion-logic-v3.js 的 `zoomIn`/`zoomOut`：只呼叫
 * `setZoom`（不帶錨點），平移量不變，只是縮放係數改變——與滑鼠滾輪縮放
 * （`zoomByWheel`，以游標為錨點）是兩條不同路徑，這裡刻意不重用那一條。
 */
export function ZoomMenu({ zoomPan, onChange, onClose }: ZoomMenuProps) {
  function zoomIn(): void {
    onChange(setZoom(zoomPan, zoomPan.zoom * 1.25));
  }
  function zoomOut(): void {
    onChange(setZoom(zoomPan, zoomPan.zoom / 1.25));
  }
  function pick(preset: number): void {
    onChange(setZoom(zoomPan, preset));
  }
  function fit(): void {
    onChange(zoomFit(zoomPan));
    onClose();
  }

  return (
    <div className="floating-layer zoom-menu" role="menu" aria-label="Zoom">
      <button type="button" className="zoom-menu-step" aria-label="Zoom out" onClick={zoomOut}>
        −
      </button>
      <span className="zoom-menu-current">{formatZoomPercent(zoomPan.zoom)}</span>
      <button type="button" className="zoom-menu-step" aria-label="Zoom in" onClick={zoomIn}>
        +
      </button>
      <span className="zoom-menu-divider" />
      <button type="button" className="zoom-menu-preset" onClick={fit}>
        Fit
      </button>
      {ZOOM_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          className="zoom-menu-preset"
          data-active={zoomPan.zoom === preset || undefined}
          onClick={() => pick(preset)}
        >
          {formatZoomPercent(preset)}
        </button>
      ))}
    </div>
  );
}
