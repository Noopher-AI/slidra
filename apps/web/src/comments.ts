import { readSlideComments, type SlideComment } from "./metadata-scan.js";

/** [E2.T8]: a comment read back out with the slide it lives on — mirrors core's `SlideCommentWithPath` without importing the CLI-facing package into the browser bundle. */
export interface SlideCommentWithPath extends SlideComment {
  slidePath: string;
}

export interface NumberedComment extends SlideCommentWithPath {
  /** 1-based, assigned by `sortComments` — the number `.comment-pin` and Pinned context both render. */
  number: number;
  /** 1-based index of `slidePath` in the deck — the "Slide N" label each Pinned context row shows. */
  slideNumber: number;
}

export interface DeckCommentsResult {
  comments: SlideCommentWithPath[];
  /** One message per slide whose markup could not be fetched or parsed — never conflated with "this slide simply has no comments" (§4.7 of the [E2.T8] plan). */
  errors: string[];
}

/**
 * Fetches every slide's raw markup and parses each with `readSlideComments`,
 * in `slides`' own order (so `sortComments`'s page-index lookup and the
 * server's `/api/chat` context prefix agree on ordering without either
 * side re-deriving it).
 *
 * Deliberately `/api/raw/`, not `/api/files/` (`notes.ts`'s route): `/api/files/`
 * runs `{{ slide_number }}` substitution on slide paths, so a comment whose
 * text happens to contain that literal string would read back differently
 * than the raw bytes the server's context-builder (`session.ts`) sends the
 * agent. `/api/raw/` returns the same bytes both sides see.
 *
 * A fetch failure or a parse failure for one slide contributes a message to
 * `errors` and contributes nothing to `comments` for that slide — it is
 * never treated as "this slide has no comments", so callers must surface
 * `errors` (existing `CanvasState.error` channel) rather than silently
 * drop it.
 */
export async function fetchDeckComments(slides: readonly string[]): Promise<DeckCommentsResult> {
  const comments: SlideCommentWithPath[] = [];
  const errors: string[] = [];

  for (const slidePath of slides) {
    let response: Response;
    try {
      response = await fetch(`/api/raw/${slidePath}`);
    } catch (error) {
      errors.push(`無法讀取 ${slidePath} 的留言：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!response.ok) {
      errors.push(`無法讀取 ${slidePath} 的留言（HTTP ${response.status}）`);
      continue;
    }
    const markup = await response.text();
    try {
      for (const comment of readSlideComments(markup)) {
        comments.push({ ...comment, slidePath });
      }
    } catch (error) {
      errors.push(`無法解析 ${slidePath} 的留言：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { comments, errors };
}

/**
 * The deck-wide numbering rule (plan §3.9 decision 3): sort key is (1) the
 * slide's index in `slides`, (2) a page-level comment before any
 * element-level comment on the same slide, (3) document order otherwise —
 * deliberately not the prototype's geometric sort (`box.t`/`box.l`), which
 * would need every other slide's fonts resolved just to place a number.
 * Assigns 1-based `number`s to the result.
 */
export function sortComments(comments: readonly SlideCommentWithPath[], slides: readonly string[]): NumberedComment[] {
  const pageIndex = new Map(slides.map((path, index) => [path, index]));
  return comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => {
      const pageDelta = (pageIndex.get(a.comment.slidePath) ?? Number.MAX_SAFE_INTEGER) - (pageIndex.get(b.comment.slidePath) ?? Number.MAX_SAFE_INTEGER);
      if (pageDelta !== 0) return pageDelta;
      const priorityDelta = (a.comment.target === "page" ? 0 : 1) - (b.comment.target === "page" ? 0 : 1);
      if (priorityDelta !== 0) return priorityDelta;
      return a.index - b.index;
    })
    .map(({ comment }, index) => ({
      ...comment,
      number: index + 1,
      slideNumber: (pageIndex.get(comment.slidePath) ?? -1) + 1,
    }));
}
