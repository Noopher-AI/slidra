import { useLayoutEffect, useRef, type RefObject } from "react";
import { Icon } from "../../icons/index.js";

export interface ContextBarProps {
  /** The selection's union box, `.stage-overlays`-relative px; `null` when nothing is selected. */
  union: { x: number; y: number; width: number; height: number } | null;
  /** The overlay's own bounding box (well size) — decides the below/above flip and the horizontal clamp. */
  bounds: { width: number; height: number };
  /** Hidden while a drag is in progress (`OverlayState.dragging`). */
  dragging: boolean;
  /**
   * [E5.T7]/F-17: whether the bar has "solidified" (`OverlayLayer`'s own
   * `createHoverSolidifier`, driven by hover position) — adds `.is-solid`,
   * which is what actually flips `pointer-events` back to `auto`
   * (`stage-overlays.css`). Defaults to `false` (ghost) so every existing
   * call site — none of which know about hover — renders exactly as before.
   */
  solid?: boolean;
  /**
   * [E5.T7]/F-17: lets `OverlayLayer` read this element's own
   * `getBoundingClientRect()` to compare against the tracked pointer
   * position — the placement `useLayoutEffect` below already needs its own
   * ref for the same node, so when the caller supplies one this replaces
   * that internal ref instead of stacking a second one. Optional so every
   * existing call site is unaffected.
   */
  barRef?: RefObject<HTMLDivElement | null>;
  /** [E2.T7]: `OverlayState.hasAnimation` — whether Edit animation renders at all (not merely disabled) next to Edit style. */
  hasAnimation: boolean;
  /** [E2.T7]: switches the right rail to Animate › Object. Never called when `hasAnimation` is false (the button does not render). */
  onEditAnimation(): void;
  /** #200 §4.5: switches the right rail to Style › Object. No command is sent, no selection changes. */
  onEditStyle(): void;
  /** [E2.T8]: "Comment to AI" click — the caller (`OverlayLayer`) resolves target (single element vs "page" for 2+) and add-vs-edit mode from the live selection, this button only signals the click itself. */
  onComment(): void;
  onOrder(direction: "front" | "up" | "down" | "back"): void;
  /** [E2.T18]: Copy/Cut always render (parity with Duplicate/Delete) — same "disabled state doesn't exist here, no selection means no bar at all" posture the rest of this component already has (`union === null` hides the whole bar). */
  onCopy(): void;
  onCut(): void;
  onPaste(): void;
  onDuplicate(): void;
  onDelete(): void;
}

/**
 * Placement constants, mirroring the prototype's `place()`
 * (slidra-logic-v3.js:416), except horizontally: the bar is left-aligned
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
 * `Slidra (New v3).dc.html` 的 ctx bar；內容是原型情境列加上原本元素右鍵選單
 * 的項目（review 決定拿掉右鍵選單、全部併到左鍵這一列）：
 * 「Comment to AI ｜ Edit style ｜ Edit animation（僅選取元素有動畫時）｜
 * 前後層四項（只有圖示） ｜ Copy／Cut／Paste（[E2.T18] 新增）｜ Duplicate ｜ Delete」。
 * Order／Duplicate／Delete 接到 controller 的同一組方法（鍵盤與 Arrange 選單
 * 共用）；Comment to AI 是佈局佔位按鈕，功能屬 NOOP-67；Edit style（#200/NOOP-69）
 * 只切右欄到 Style › Object，不送任何命令、不改選取。
 * [E2.T7]：Edit animation 只在 `hasAnimation` 為 true 時渲染（不是 disabled——
 * 07-DISCUSSION_LOG.md「無動畫時不顯示 Edit animation」），插入點固定在 Edit
 * style 的 `</button>` 之後、下一個 divider 之前（單一插入點，見 NOOP-124 計畫
 * 對 [E2.T8] 同時改這個檔案的衝突提醒），點擊只切右欄到 Animate › Object，不
 * 送任何命令、不改選取。 */
export function ContextBar({ union, bounds, dragging, hasAnimation, solid = false, barRef: externalBarRef, onEditAnimation, onEditStyle, onComment, onOrder, onCopy, onCut, onPaste, onDuplicate, onDelete }: ContextBarProps) {
  const internalBarRef = useRef<HTMLDivElement | null>(null);
  const barRef = externalBarRef ?? internalBarRef;
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

  if (!union || dragging) return null;
  const below = union.y + union.height + GAP;
  const fitsBelow = below + BAR_HEIGHT <= bounds.height - DOCK_RESERVE;
  const top = Math.min(fitsBelow ? below : Math.max(MARGIN, union.y - GAP - BAR_HEIGHT), bounds.height - DOCK_RESERVE - BAR_HEIGHT);
  return (
    <div ref={barRef} className={`context-bar${solid ? " is-solid" : ""}`} role="toolbar" aria-label="Selection" style={{ left: union.x, top }}>
      <button type="button" className="context-bar-item context-bar-item-comment" title="Comment to AI" onClick={onComment}>
        <Icon name="comment" size="control" />
        Comment to AI
      </button>
      <span className="context-bar-divider" />
      <button type="button" className="context-bar-item" title="Edit style" onClick={onEditStyle}>
        <Icon name="edit" size="control" />
        Edit style
      </button>
      {hasAnimation && (
        <button type="button" className="context-bar-item" title="Edit animation" onClick={onEditAnimation}>
          <Icon name="spark" size="control" />
          Edit animation
        </button>
      )}
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
      <button type="button" className="context-bar-item context-bar-item-icon" title="Copy" aria-label="Copy" onClick={onCopy}>
        <Icon name="copy" size="control" />
      </button>
      <button type="button" className="context-bar-item context-bar-item-icon" title="Cut" aria-label="Cut" onClick={onCut}>
        <Icon name="cut" size="control" />
      </button>
      <button type="button" className="context-bar-item context-bar-item-icon" title="Paste" aria-label="Paste" onClick={onPaste}>
        <Icon name="paste" size="control" />
      </button>
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
  );
}
