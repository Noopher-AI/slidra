export interface GuideLayerProps {
  /** `.stage-overlays`-relative px (already converted by `OverlayLayer`). */
  guides: { orientation: "v" | "h"; position: number }[];
}

/**
 * 拖曳吸附輔助線（NOOP-90/T2 ADR-0011 amend）：畫在父文件了，不再是
 * selection-runtime.js 裡的 `.guide`（那份實作已移除，見 selection-runtime.js
 * 的 `bounds`/`preview` 訊息與這裡的 `OverlayState.guides`）。
 */
export function GuideLayer({ guides }: GuideLayerProps) {
  return (
    <div className="guide-layer">
      {guides.map((guide, index) => (
        <div
          key={`${guide.orientation}-${index}`}
          className={`guide guide-${guide.orientation}`}
          style={guide.orientation === "v" ? { left: guide.position } : { top: guide.position }}
        />
      ))}
    </div>
  );
}
