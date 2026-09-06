export interface SelectionOverlayProps {
  /** The selection's union box, `.stage-overlays`-relative px; `null` when nothing is selected. */
  union: { x: number; y: number; width: number; height: number } | null;
  /** `null` when nothing selected; single selection carries `path` (ancestor names, outermost first) for the drill-in label ("Group 2 › Group 1 › 名稱"). */
  label: { text: string; path: string[] } | null;
  /**
   * [E2.T8] §4.7/§3.9: the single selected element's own comment, or
   * `null`/absent when it has none (or the selection isn't exactly one
   * element — resolved by the caller, not here: the prototype's own rule is
   * "no pin for a multi-selection", `comotion-logic-v3.js:666`). Optional
   * (not `null`-required) so every pre-[E2.T8] caller of this component
   * keeps compiling unchanged.
   */
  pin?: { commentId: string; number: number; onClick(): void } | null;
}

/** Screen px the name/group label sits above the selection box's own top edge (prototype's own `top:-22px`). */
const LABEL_OFFSET = 22;

/**
 * 名稱／群組／鑽入路徑標籤（NOOP-90/T2 §4.1, §3.7）。選取框本身、四角把
 * 手、框選矩形仍然畫在 iframe 的 Shadow DOM 裡（ADR-0011 未變的那一半）——
 * 這裡只畫父文件那一半：標籤，加上 [E2.T8] 的留言 pin（標籤同一列，右側）。
 */
export function SelectionOverlay({ union, label, pin }: SelectionOverlayProps) {
  if (!union || !label) return <div className="selection-overlay" />;
  const text = label.path.length > 0 ? [...label.path, label.text].join(" › ") : label.text;
  return (
    <div className="selection-overlay">
      <div className="selection-label-row" style={{ left: union.x, top: union.y - LABEL_OFFSET }}>
        <div className="selection-label">{text}</div>
        {pin && (
          <button type="button" className="comment-pin" data-comment-id={pin.commentId} onClick={pin.onClick}>
            {pin.number}
          </button>
        )}
      </div>
    </div>
  );
}
