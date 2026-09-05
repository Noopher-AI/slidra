export interface ContextBarProps {
  /** The selection's union box, `.stage-overlays`-relative px; `null` when nothing is selected. */
  union: { x: number; y: number; width: number; height: number } | null;
  /** The overlay's own bounding box (well size) — decides the below/above flip. */
  bounds: { height: number };
  onDelete(): void;
}

/** Estimated context-bar height/gap for the below/above flip decision (05-INTERACTIONS.feature「選取 › 單選」「情境列出現在選取框正下方（空間不足則翻到上方）」) — the bar's real height depends on content, but this ticket's bar (Delete only) never exceeds it. */
const BAR_HEIGHT = 40;
const GAP = 8;

/**
 * 選取框下方的情境列（NOOP-90/T2 §0.3 裁決）：本票只做容器、定位、Delete
 * 一顆按鈕——Comment to AI／Edit style／Edit animation 三顆分屬 NOOP-67/69/66，
 * 由它們自己往這個容器加按鈕。
 */
export function ContextBar({ union, bounds, onDelete }: ContextBarProps) {
  if (!union) return <div className="context-bar-layer" />;
  const fitsBelow = union.y + union.height + GAP + BAR_HEIGHT <= bounds.height;
  const top = fitsBelow ? union.y + union.height + GAP : union.y - GAP - BAR_HEIGHT;
  return (
    <div className="context-bar-layer">
      <div className="context-bar" style={{ left: union.x, top }}>
        <button type="button" className="context-bar-item" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
