export interface SelectionOverlayProps {
  /** The selection's union box, `.stage-overlays`-relative px; `null` when nothing is selected. */
  union: { x: number; y: number; width: number; height: number } | null;
  /** `null` when nothing selected; single selection carries `path` (ancestor names, outermost first) for the drill-in label ("Group 2 › Group 1 › name"). */
  label: { text: string; path: string[] } | null;
  /**
   * [E2.T8] §4.7/§3.9: the single selected element's own comment, or
   * `null`/absent when it has none (or the selection isn't exactly one
   * element — resolved by the caller, not here: the prototype's own rule is
   * "no pin for a multi-selection", `slidra-logic-v3.js:666`). Optional
   * (not `null`-required) so every pre-[E2.T8] caller of this component
   * keeps compiling unchanged.
   */
  pin?: { commentId: string; number: number; onClick(): void } | null;
}

/** Screen px the name/group label sits above the selection box's own top edge (prototype's own `top:-22px`). */
const LABEL_OFFSET = 22;

/**
 * The name/group/drill-in-path label. The selection box itself, its
 * four-corner handles, and the marquee rectangle are still drawn inside the
 * iframe's Shadow DOM (the half that hasn't changed) — this component only
 * paints the parent-document half: the label, plus the comment pin (same
 * row as the label, on the right side).
 */
export function SelectionOverlay({ union, label, pin }: SelectionOverlayProps) {
  if (!union || !label) return null;
  const text = label.path.length > 0 ? [...label.path, label.text].join(" › ") : label.text;
  return (
    <div className="selection-label-row" style={{ left: union.x, top: union.y - LABEL_OFFSET }}>
      <div className="selection-label">{text}</div>
      {pin && (
        <button type="button" className="comment-pin" data-comment-id={pin.commentId} onClick={pin.onClick}>
          {pin.number}
        </button>
      )}
    </div>
  );
}
