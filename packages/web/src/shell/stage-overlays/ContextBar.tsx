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
 * 翻到上方）」). Height matches `.context-bar`'s CSS exactly: 28px compact
 * buttons + 4px padding each side = 36px. Gap is the prototype's 8px plus
 * the 5px extra breathing room asked for in review.
 */
const BAR_HEIGHT = 36;
const GAP = 13;

/**
 * 選取框下方的情境列（NOOP-90/T2 §0.3 裁決，2026-09 review 修訂）：外觀與內容
 * 照原型 `CoMotion (New v3).dc.html` 的 ctx bar 一模一樣——
 * 「Comment to AI ｜ Edit style ｜ Delete」（03-UI_RATIONALE「情境列」）。
 * 本票只有 Delete 接了功能；Comment to AI／Edit style 是原型外觀的佈局佔位
 * 按鈕，按下沒有反應，功能分屬 NOOP-67／NOOP-69。原型的 Edit animation 只在
 * 元素已有動畫時出現（07-DISCUSSION_LOG「無動畫時不顯示」），判斷來源屬
 * NOOP-66，這裡尚未渲染。
 */
export function ContextBar({ union, bounds, onDelete }: ContextBarProps) {
  if (!union) return <div className="context-bar-layer" />;
  const fitsBelow = union.y + union.height + GAP + BAR_HEIGHT <= bounds.height;
  const top = fitsBelow ? union.y + union.height + GAP : union.y - GAP - BAR_HEIGHT;
  return (
    <div className="context-bar-layer">
      <div className="context-bar" role="toolbar" aria-label="Selection" style={{ left: union.x, top }}>
        {/* NOOP-67 wires this up. */}
        <button type="button" className="context-bar-item context-bar-item-comment" title="Comment to AI">
          <Icon name="comment" size="control" />
          Comment to AI
        </button>
        <span className="context-bar-divider" />
        {/* NOOP-69 wires this up. */}
        <button type="button" className="context-bar-item" title="Edit style">
          <Icon name="edit" size="control" />
          Edit style
        </button>
        <span className="context-bar-divider" />
        <button type="button" className="context-bar-item context-bar-item-danger" title="Delete" onClick={onDelete}>
          <Icon name="trash" size="control" />
          Delete
        </button>
      </div>
    </div>
  );
}
