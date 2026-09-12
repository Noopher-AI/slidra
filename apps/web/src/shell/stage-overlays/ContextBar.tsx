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
   * Whether the bar has "solidified" (`OverlayLayer`'s own
   * `createHoverSolidifier`, driven by hover position) — adds `.is-solid`,
   * which is what actually flips `pointer-events` back to `auto`
   * (`stage-overlays.css`). Defaults to `false` (ghost) so every existing
   * call site — none of which know about hover — renders exactly as before.
   */
  solid?: boolean;
  /**
   * Lets `OverlayLayer` read this element's own
   * `getBoundingClientRect()` to compare against the tracked pointer
   * position — the placement `useLayoutEffect` below already needs its own
   * ref for the same node, so when the caller supplies one this replaces
   * that internal ref instead of stacking a second one. Optional so every
   * existing call site is unaffected.
   */
  barRef?: RefObject<HTMLDivElement | null>;
  /** `OverlayState.hasAnimation` — whether Edit animation renders at all (not merely disabled) next to Edit style. */
  hasAnimation: boolean;
  /** Switches the right rail to Animate › Object. Never called when `hasAnimation` is false (the button does not render). */
  onEditAnimation(): void;
  /** Switches the right rail to Style › Object. No command is sent, no selection changes. */
  onEditStyle(): void;
  /** "Comment to AI" click — the caller (`OverlayLayer`) resolves target (single element vs "page" for 2+) and add-vs-edit mode from the live selection, this button only signals the click itself. */
  onComment(): void;
  onOrder(direction: "front" | "up" | "down" | "back"): void;
  /** Copy/Cut always render (parity with Duplicate/Delete) — same "disabled state doesn't exist here, no selection means no bar at all" posture the rest of this component already has (`union === null` hides the whole bar). */
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
 * The context bar below the selection box. Its look follows the prototype's
 * `Slidra (New v3).dc.html` ctx bar; its content is the prototype's context
 * bar plus the items from the original element right-click menu (the
 * right-click menu was dropped in favor of folding everything into this
 * left-click bar):
 * "Comment to AI | Edit style | Edit animation (only when the selected
 * element has animation) | the four layer-order items (icon-only) |
 * Copy/Cut/Paste | Duplicate | Delete".
 * Order/Duplicate/Delete hook into the same controller methods used by the
 * keyboard shortcuts and the Arrange menu; Comment to AI is a layout
 * placeholder button whose actual functionality lives elsewhere; Edit style
 * only switches the right rail to Style › Object, sending no command and
 * changing no selection.
 * Edit animation only renders when `hasAnimation` is true (not merely
 * disabled — it should not show at all when there is no animation), its
 * insertion point fixed right after Edit style's `</button>` and before the
 * next divider (a single insertion point, so any future edit to this file
 * doesn't conflict with an edit elsewhere in the same spot); clicking it
 * only switches the right rail to Animate › Object, sending no command and
 * changing no selection. */
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
