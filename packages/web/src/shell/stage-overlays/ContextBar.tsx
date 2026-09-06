import { useLayoutEffect, useRef } from "react";
import { Icon } from "../../icons/index.js";

export interface ContextBarProps {
  /** The selection's union box, `.stage-overlays`-relative px; `null` when nothing is selected. */
  union: { x: number; y: number; width: number; height: number } | null;
  /** The overlay's own bounding box (well size) — decides the below/above flip and the horizontal clamp. */
  bounds: { width: number; height: number };
  /** Hidden while a drag is in progress (`OverlayState.dragging`). */
  dragging: boolean;
  /** [E2.T8]: "Comment to AI" click — the caller (`OverlayLayer`) resolves target (single element vs "page" for 2+) and add-vs-edit mode from the live selection, this button only signals the click itself. */
  onComment(): void;
  onOrder(direction: "front" | "up" | "down" | "back"): void;
  onDuplicate(): void;
  onDelete(): void;
}

/**
 * Placement constants, mirroring the prototype's `place()`
 * (comotion-logic-v3.js:416), except horizontally: the bar is left-aligned
 * with the selection box (review decision) instead of centred, kept
 * MARGIN px inside the well, flips above the selection when it would run into
 * the DOCK_RESERVE strip the floating Dock lives in (--space-gutter-bottom),
 * and never sinks into that strip either way. BAR_HEIGHT matches
 * `.context-bar`'s CSS exactly (28px compact buttons + 4px padding each side);
 * GAP is the prototype's 8px plus the 5px extra breathing room asked for in
 * review.
 */
const BAR_HEIGHT = 36;
const GAP = 13;
const MARGIN = 8;
const DOCK_RESERVE = 76;

const ORDER_ITEMS: { direction: "front" | "up" | "down" | "back"; label: string; icon: "front" | "forward" | "backward" | "back" }[] = [
  { direction: "front", label: "Bring to front", icon: "front" },
  { direction: "up", label: "Bring forward", icon: "forward" },
  { direction: "down", label: "Send backward", icon: "backward" },
  { direction: "back", label: "Send to back", icon: "back" },
];

/**
 * 選取框下方的情境列（NOOP-90/T2 §0.3 裁決，issue 198 review 修訂）。外觀照原型
 * `CoMotion (New v3).dc.html` 的 ctx bar；內容是原型情境列加上原本元素右鍵選單
 * 的項目（review 決定拿掉右鍵選單、全部併到左鍵這一列）：
 * 「Comment to AI ｜ Edit style ｜ 前後層四項（只有圖示） ｜ Duplicate ｜ Delete」。
 * Order／Duplicate／Delete 接到 controller 的同一組方法（鍵盤與 Arrange 選單
 * 共用）；Comment to AI／Edit style 是佈局佔位按鈕，功能分屬 NOOP-67／NOOP-69。
 * 原型的 Edit animation 只在元素已有動畫時出現，判斷來源屬 NOOP-66，尚未渲染。
 */
export function ContextBar({ union, bounds, dragging, onComment, onOrder, onDuplicate, onDelete }: ContextBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const unionX = union?.x ?? 0;
  // Horizontal placement needs the bar's rendered width (content-dependent),
  // so it is applied after layout: left-aligned with the selection box, then
  // clamped inside the well so a selection near the right edge never pushes
  // the bar under the side panel.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const width = bar.offsetWidth;
    const left = Math.max(MARGIN, Math.min(unionX, bounds.width - width - MARGIN));
    bar.style.left = `${Math.round(left)}px`;
  }, [unionX, bounds.width, dragging]);

  if (!union || dragging) return <div className="context-bar-layer" />;
  const below = union.y + union.height + GAP;
  const fitsBelow = below + BAR_HEIGHT <= bounds.height - DOCK_RESERVE;
  const top = Math.min(fitsBelow ? below : Math.max(MARGIN, union.y - GAP - BAR_HEIGHT), bounds.height - DOCK_RESERVE - BAR_HEIGHT);
  return (
    <div className="context-bar-layer">
      <div ref={barRef} className="context-bar" role="toolbar" aria-label="Selection" style={{ left: union.x, top }}>
        <button type="button" className="context-bar-item context-bar-item-comment" title="Comment to AI" onClick={onComment}>
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
        {ORDER_ITEMS.map((item) => (
          <button
            key={item.direction}
            type="button"
            className="context-bar-item context-bar-item-icon"
            title={item.label}
            aria-label={item.label}
            onClick={() => onOrder(item.direction)}
          >
            <Icon name={item.icon} size="control" />
          </button>
        ))}
        <span className="context-bar-divider" />
        <button type="button" className="context-bar-item" title="Duplicate" onClick={onDuplicate}>
          <Icon name="dup" size="control" />
          Duplicate
        </button>
        <button type="button" className="context-bar-item context-bar-item-danger" title="Delete" onClick={onDelete}>
          <Icon name="trash" size="control" />
          Delete
        </button>
      </div>
    </div>
  );
}
