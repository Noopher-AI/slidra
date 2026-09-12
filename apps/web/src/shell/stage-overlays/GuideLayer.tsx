export interface GuideLayerProps {
  /** `.stage-overlays`-relative px (already converted by `OverlayLayer`). */
  guides: { orientation: "v" | "h"; position: number }[];
}

/**
 * Drag-snap alignment guides: now drawn in the parent document instead of
 * as the `.guide` in selection-runtime.js (that implementation has been
 * removed — see selection-runtime.js's `bounds`/`preview` messages and
 * this component's `OverlayState.guides`).
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
