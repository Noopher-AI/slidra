import { CommentComposer } from "./CommentComposer.js";

export interface CommentLayerProps {
  open: boolean;
  /** The current selection's union box (well-relative px) when the composer targets a single element; `null` for a whole-page comment. */
  anchor: { x: number; y: number; width: number; height: number } | null;
  bounds: { width: number; height: number };
  draft: string;
  onDraftChange(text: string): void;
  editingCommentId: string | null;
  onSubmit(): void;
  onDelete(): void;
  onClose(): void;
}

/** 與 AI 協作的留言框（[E2.T8]）。見 SelectionOverlay.tsx 同樣的範圍說明。 */
export function CommentLayer({ open, anchor, bounds, draft, onDraftChange, editingCommentId, onSubmit, onDelete, onClose }: CommentLayerProps) {
  return (
    <CommentComposer
      open={open}
      anchor={anchor}
      bounds={bounds}
      draft={draft}
      onDraftChange={onDraftChange}
      editingCommentId={editingCommentId}
      excludeRefs={[]}
      onSubmit={onSubmit}
      onDelete={onDelete}
      onClose={onClose}
    />
  );
}
