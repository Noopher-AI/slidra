import { Icon } from "../../icons/index.js";

export interface ContextBarProps {
  /** The selection's union box, `.stage-overlays`-relative px; `null` when nothing is selected. */
  union: { x: number; y: number; width: number; height: number } | null;
  /** The overlay's own bounding box (well size) — decides the below/above flip. */
  bounds: { height: number };
  onDelete(): void;
}

/**
 * Context-bar height/gap for the below/above flip decision
 * (05-INTERACTIONS.feature「選取 › 單選」「情境列出現在選取框正下方（空間不足則
 * 翻到上方）」). Matches the prototype's glass bar exactly: 30px buttons +
 * 5px padding on each side = 40px — `.context-bar`'s CSS pins the same
 * numbers, so the two never drift.
 */
const BAR_HEIGHT = 40;
const GAP = 8;

/**
 * 選取框下方的情境列（NOOP-90/T2 §0.3 裁決）：本票做的是設計稿的玻璃容器
 * （01-DESIGN_TOKENS「玻璃材質」：`--glass-bg-soft`／blur／`--shadow-glass`）、
 * 定位、以及 Delete 一顆按鈕。設計稿的完整內容是
 * 「Comment to AI ｜ Edit style · Edit animation ｜ Delete」
 * （03-UI_RATIONALE「情境列」）——Comment to AI／Edit style／Edit animation 三顆
 * 分屬 NOOP-67/69/66，各自往這個容器的 `.context-bar-slot-*` 位置加按鈕；
 * 分隔線已按設計稿放好，後續票只加按鈕、不動版面。
 */
export function ContextBar({ union, bounds, onDelete }: ContextBarProps) {
  if (!union) return <div className="context-bar-layer" />;
  const fitsBelow = union.y + union.height + GAP + BAR_HEIGHT <= bounds.height;
  const top = fitsBelow ? union.y + union.height + GAP : union.y - GAP - BAR_HEIGHT;
  return (
    <div className="context-bar-layer">
      <div className="context-bar" role="toolbar" aria-label="Selection" style={{ left: union.x, top }}>
        {/* Comment to AI — NOOP-67 fills this slot. */}
        <span className="context-bar-slot context-bar-slot-comment" />
        <span className="context-bar-divider" />
        {/* Edit style · Edit animation — NOOP-69 / NOOP-66 fill this slot. */}
        <span className="context-bar-slot context-bar-slot-edit" />
        <span className="context-bar-divider" />
        <button type="button" className="context-bar-item context-bar-item-danger" title="Delete" onClick={onDelete}>
          <Icon name="trash" size="control" />
          Delete
        </button>
      </div>
    </div>
  );
}
