export interface SelectionOverlayProps {
  /** The selection's union box, `.stage-overlays`-relative px; `null` when nothing is selected. */
  union: { x: number; y: number; width: number; height: number } | null;
  /** `null` when nothing selected; single selection carries `path` (ancestor names, outermost first) for the drill-in label ("Group 2 › Group 1 › 名稱"). */
  label: { text: string; path: string[] } | null;
}

/** Screen px the name/group label sits above the selection box's own top edge (prototype's own `top:-22px`). */
const LABEL_OFFSET = 22;

/**
 * 名稱／群組／鑽入路徑標籤（NOOP-90/T2 §4.1, §3.7）。選取框本身、四角把
 * 手、框選矩形仍然畫在 iframe 的 Shadow DOM 裡（ADR-0011 未變的那一半）——
 * 這裡只畫父文件那一半：標籤。
 */
export function SelectionOverlay({ union, label }: SelectionOverlayProps) {
  if (!union || !label) return <div className="selection-overlay" />;
  const text = label.path.length > 0 ? [...label.path, label.text].join(" › ") : label.text;
  return (
    <div className="selection-overlay">
      <div className="selection-label" style={{ left: union.x, top: union.y - LABEL_OFFSET }}>
        {text}
      </div>
    </div>
  );
}
