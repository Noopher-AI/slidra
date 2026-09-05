/**
 * 選取框／把手／名稱標籤（空容器）。選取/拖曳/縮放是明確排除在這張骨架
 * 票之外的範圍（見 ticket 說明），這裡不畫任何東西——CanvasState.selection
 * 已經存在（canvas.ts 未改動），未來票直接消費它即可，不需要回來動這個
 * 容器的掛載方式。
 */
export function SelectionOverlay() {
  return <div className="selection-overlay" />;
}
