import { addComment, deleteComment, editComment, listAllComments, listComments, type SlideCommentWithPath } from "@co-motion/core";
import type { CommandHandler, CommandRegistry } from "../registry.js";

/**
 * `comment add / edit / delete / list` ([E2.T8]). Thin CommandHandler
 * wrappers over `@co-motion/core`'s `slide-ops.ts` — same split as
 * `slide.ts`'s wrappers over `slide-ops.ts`'s other five functions.
 */

export interface CommentAddInput {
  id: string;
  slidePath: string;
  /** An element id, or the literal string `"page"`. */
  target: string;
  text: string;
  author?: string;
}

export interface CommentAddData {
  commentId: string;
}

export const commentAddCommand: CommandHandler<CommentAddInput, CommentAddData> = async (input) => {
  const commentId = await addComment(input.id, input.slidePath, input.target, input.text, input.author ?? "agent");
  return { ok: true, data: { commentId }, message: `已在 ${input.slidePath} 新增留言 ${commentId}` };
};

export interface CommentEditInput {
  id: string;
  slidePath: string;
  commentId: string;
  text: string;
}
export type CommentEditData = Record<string, never>;

export const commentEditCommand: CommandHandler<CommentEditInput, CommentEditData> = async (input) => {
  await editComment(input.id, input.slidePath, input.commentId, input.text);
  return { ok: true, data: {}, message: `已更新留言 ${input.commentId}` };
};

export interface CommentDeleteInput {
  id: string;
  slidePath: string;
  commentId: string;
}
export type CommentDeleteData = Record<string, never>;

export const commentDeleteCommand: CommandHandler<CommentDeleteInput, CommentDeleteData> = async (input) => {
  await deleteComment(input.id, input.slidePath, input.commentId);
  return { ok: true, data: {}, message: `已刪除留言 ${input.commentId}` };
};

export interface CommentListInput {
  id: string;
  /** Omit to list every slide's comments, deck-wide. */
  slidePath?: string;
}

export interface CommentListData {
  comments: SlideCommentWithPath[];
}

export const commentListCommand: CommandHandler<CommentListInput, CommentListData> = async (input) => {
  const comments = input.slidePath !== undefined ? await listComments(input.id, input.slidePath) : await listAllComments(input.id);
  return { ok: true, data: { comments }, message: `共 ${comments.length} 則留言` };
};

export function register(registry: CommandRegistry): void {
  registry.register("comment add", { handler: commentAddCommand, render: null });
  registry.register("comment edit", { handler: commentEditCommand, render: null });
  registry.register("comment delete", { handler: commentDeleteCommand, render: null });
  registry.register("comment list", { handler: commentListCommand, render: null });
}
