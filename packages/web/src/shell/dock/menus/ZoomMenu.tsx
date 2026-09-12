import { ZOOM_PRESETS, formatZoomPercent, setZoom, zoomFit, type ZoomPanState } from "../../stage-view.js";

export interface ZoomMenuProps {
  zoomPan: ZoomPanState;
  onChange(next: ZoomPanState): void;
  onClose(): void;
}

/**
 * Zoom menu — the only floating layer required to be fully functional in
 * this skeleton pass (every other Dock panel/menu is still an empty
 * container). Layout: − | percentage | + | Fit | presets, with the current
 * value highlighted via `--brand-red`; choosing Fit resets to 100% and
 * re-centers.
 *
 * The +/− buttons mirror comotion-logic-v3.js's `zoomIn`/`zoomOut`: they
 * only call `setZoom` (no anchor point), leaving the pan offset unchanged
 * and only changing the zoom factor — a different path from mouse-wheel
 * zoom (`zoomByWheel`, anchored on the cursor), which is deliberately not
 * reused here.
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
