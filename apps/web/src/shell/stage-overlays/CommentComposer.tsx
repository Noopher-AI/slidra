import { useLayoutEffect, useRef, type RefObject } from "react";
import { useCloseFloatingLayer } from "../use-floating-layer.js";

/**
 * Placement constants — same shape as `ContextBar.tsx`'s own (prototype's
 * `placeComposer()`, slidra-logic-v3.js:413-428), except this composer
 * centers horizontally on the selection instead of left-aligning (that's
 * `ContextBar`'s own review decision, not this component's).
 */
const GAP = 24;
const MARGIN = 8;
const DOCK_RESERVE = 76;
/** No selection (whole-page comment): vertical offset from the well's own top, prototype's `stage.top + 16`. */
const NO_SELECTION_TOP = 16;

export interface CommentComposerProps {
  open: boolean;
  /** The selection's union box, `.stage-overlays`-relative px; `null` for a whole-page comment (no selection). */
  anchor: { x: number; y: number; width: number; height: number } | null;
  /** The overlay's own bounding box (well size) — same role as `ContextBar`'s `bounds`. */
  bounds: { width: number; height: number };
  /** Controlled draft text — owned by `App.tsx` (plan §1), not this component, so a chat-panel-driven refresh never loses an in-progress draft. */
  draft: string;
  onDraftChange(text: string): void;
  /** The comment id being edited; `null` when composing a brand-new one — decides "Add comment" vs "Save changes" + Delete. */
  editingCommentId: string | null;
  /** Refs to exclude from the "outside mousedown closes" check — the button that opened this composer, so its own mousedown never double-closes-then-reopens it. */
  excludeRefs: ReadonlyArray<RefObject<HTMLElement | null>>;
  onSubmit(): void;
  onDelete(): void;
  onClose(): void;
}

/**
 * The glass comment composer ([E2.T8] §4.7/§4.9 of the plan): grows from
 * the selection box (or centers on the stage for a whole-page comment),
 * ⌘/Ctrl+Enter submits, Esc or an outside mousedown closes and discards the
 * draft (`useCloseFloatingLayer`, same contract as `ExportPanel`/`Dock`'s
 * own floating layers).
 */
export function CommentComposer({
  open,
  anchor,
  bounds,
  draft,
  onDraftChange,
  editingCommentId,
  excludeRefs,
  onSubmit,
  onDelete,
  onClose,
}: CommentComposerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useCloseFloatingLayer(open, [rootRef, ...excludeRefs], onClose);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !open) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left: number;
    let top: number;
    if (anchor) {
      left = anchor.x + anchor.width / 2 - width / 2;
      const below = anchor.y + anchor.height + GAP;
      const fitsBelow = below + height <= bounds.height - DOCK_RESERVE;
      top = fitsBelow ? below : Math.max(MARGIN, anchor.y - GAP - height);
    } else {
      left = bounds.width / 2 - width / 2;
      top = NO_SELECTION_TOP;
    }
    left = Math.max(MARGIN, Math.min(left, bounds.width - width - MARGIN));
    top = Math.min(top, bounds.height - DOCK_RESERVE - height);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }, [open, anchor, bounds.width, bounds.height]);

  if (!open) return null;

  const isEditing = editingCommentId !== null;
  const canSubmit = draft.trim() !== "";

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <div ref={rootRef} className="comment-composer" role="dialog" aria-label="Comment to agent">
      <textarea
        className="comment-composer-input"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Comment to AI…"
        autoFocus
      />
      <div className="comment-composer-actions">
        {isEditing && (
          <button type="button" className="comment-composer-delete" onClick={onDelete}>
            Delete
          </button>
        )}
        <button type="button" className="comment-composer-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="comment-composer-submit" disabled={!canSubmit} onClick={onSubmit}>
          {isEditing ? "Save changes" : "Add comment"}
        </button>
      </div>
    </div>
  );
}
