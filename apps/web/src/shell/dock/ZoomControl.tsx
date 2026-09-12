import { formatZoomPercent } from "../stage-view.js";

export interface ZoomControlProps {
  zoom: number;
  open: boolean;
  onToggle(): void;
}

/** 工具列的百分比按鈕；點擊開/關 ZoomMenu (05-INTERACTIONS.feature「縮放選單」)。 */
export function ZoomControl({ zoom, open, onToggle }: ZoomControlProps) {
  return (
    <button
      type="button"
      className="dock-zoom-control"
      title="Zoom (⌘0 fit · ⌘+ · ⌘−)"
      aria-expanded={open}
      onClick={onToggle}
    >
      {formatZoomPercent(zoom)}
    </button>
  );
}
