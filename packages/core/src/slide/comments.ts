import { CoMotionError, CoMotionNotFoundError } from "../errors.js";
import { attributeOf, attributeValue, scanDocument, type ScannedNode } from "./scan.js";

/**
 * Author comments pinned to an element or a whole slide ([E2.T8]): a pure
 * string -> string splice, modeled on `notes.ts`'s `setSlideNotes` — every
 * other byte of `svgContent` is preserved exactly. Comments live in the
 * same `<metadata>` a slide's `<comot:effects>`/`<comot:notes>` already
 * use, as a `<comot:comments>` list of `<comot:comment>` elements, coexisting
 * without disturbing the others.
 *
 * No Node built-in imports, not even transitively: this lives in `slide/`
 * so the browser-side reader (`packages/web/src/comments.ts`) can share it.
 */

const COMMENTS_TAG = "comot:comments";
const COMMENT_TAG = "comot:comment";
const METADATA_TAG = "metadata";
/** Same namespace URI `notes.ts`'s `<comot:notes>` and `element-edit.ts`'s `<comot:effects>` bind. */
const COMMENTS_NS = "https://co-motion.dev/ns";

/**
 * `escapeXmlText`/`unescapeXmlText`'s exact duplicates (the other two
 * copies: `packages/core/src/element-text.ts`, `packages/web/src/notes.ts`).
 * Not shared on purpose — see the [E2.T8] plan's scope boundary #9: worth
 * consolidating, not this ticket.
 */
function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

export interface SlideComment {
  id: string;
  /** An element id, or the literal string `"page"`. */
  target: string;
  author: string;
  /** ISO 8601. */
  created: string;
  text: string;
}

function requireSvgRoot(roots: readonly ScannedNode[]): ScannedNode {
  const svgRoot = roots.find((node) => node.tag === "svg");
  if (!svgRoot) {
    throw new CoMotionError("投影片的根節點不是 <svg>");
  }
  return svgRoot;
}

function findCommentsList(svgRoot: ScannedNode): ScannedNode | undefined {
  const metadata = svgRoot.children.find((child) => child.tag === METADATA_TAG);
  return metadata?.children.find((child) => child.tag === COMMENTS_TAG);
}

function readComment(node: ScannedNode, svgContent: string): SlideComment {
  const id = attributeValue(node, "id");
  const target = attributeValue(node, "target");
  const author = attributeValue(node, "author");
  const created = attributeValue(node, "created");
  if (id === null || target === null || author === null || created === null) {
    throw new CoMotionError("留言缺少必要屬性");
  }
  const raw = svgContent.slice(node.contentStart, node.contentEnd);
  return { id, target, author, created, text: unescapeXmlText(raw) };
}

/**
 * Reads out a slide's comments in document order. A missing `<metadata>`,
 * a missing `<comot:comments>`, and an empty list all read the same: `[]`.
 */
export function readSlideComments(svgContent: string): SlideComment[] {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const list = findCommentsList(svgRoot);
  if (!list) return [];
  return list.children.filter((child) => child.tag === COMMENT_TAG).map((child) => readComment(child, svgContent));
}

function serializeComment(comment: SlideComment): string {
  const attrs = [
    `id="${escapeXmlAttr(comment.id)}"`,
    `target="${escapeXmlAttr(comment.target)}"`,
    `author="${escapeXmlAttr(comment.author)}"`,
    `created="${escapeXmlAttr(comment.created)}"`,
  ].join(" ");
  return `<${COMMENT_TAG} ${attrs}>${escapeXmlText(comment.text)}</${COMMENT_TAG}>`;
}

/**
 * Appends `comment` to the end of `<comot:comments>`; creates `<metadata>`
 * and/or `<comot:comments>` as needed. `id`/`created` are given by the
 * caller (injectable, for deterministic tests) — this function never mints
 * either.
 */
export function addSlideComment(svgContent: string, comment: SlideComment): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const markup = serializeComment(comment);

  const metadata = svgRoot.children.find((child) => child.tag === METADATA_TAG);
  if (!metadata) {
    const wrapped = `<${METADATA_TAG}><${COMMENTS_TAG} xmlns:comot="${COMMENTS_NS}">${markup}</${COMMENTS_TAG}></${METADATA_TAG}>`;
    const insertAt = svgRoot.contentStart;
    return svgContent.slice(0, insertAt) + wrapped + svgContent.slice(insertAt);
  }

  const list = metadata.children.find((child) => child.tag === COMMENTS_TAG);
  if (!list) {
    const wrapped = `<${COMMENTS_TAG} xmlns:comot="${COMMENTS_NS}">${markup}</${COMMENTS_TAG}>`;
    const insertAt = metadata.contentStart;
    return svgContent.slice(0, insertAt) + wrapped + svgContent.slice(insertAt);
  }

  // A `<comot:comments>` written without this namespace declaration would
  // parse fine via this scanner but throw the moment a namespace-aware
  // consumer (e.g. `DOMParser`) reads it — same fix `notes.ts` applies to
  // `<comot:notes>`. Rewrite the open tag along with the content so every
  // write leaves the element namespace-valid.
  if (attributeOf(list, "xmlns:comot")?.value !== COMMENTS_NS) {
    const existingContent = svgContent.slice(list.contentStart, list.contentEnd);
    const rewritten = `<${COMMENTS_TAG} xmlns:comot="${COMMENTS_NS}">${existingContent}${markup}`;
    return svgContent.slice(0, list.start) + rewritten + svgContent.slice(list.contentEnd);
  }

  return svgContent.slice(0, list.contentEnd) + markup + svgContent.slice(list.contentEnd);
}

function findComment(svgRoot: ScannedNode, commentId: string): ScannedNode {
  const list = findCommentsList(svgRoot);
  const found = list?.children.find(
    (child) => child.tag === COMMENT_TAG && attributeValue(child, "id") === commentId,
  );
  if (!found) {
    throw new CoMotionNotFoundError(`找不到留言：${commentId}`);
  }
  return found;
}

/** Replaces `commentId`'s content. `created` is left untouched. Unknown `commentId` throws `CoMotionNotFoundError`. */
export function editSlideComment(svgContent: string, commentId: string, text: string): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const comment = findComment(svgRoot, commentId);
  return svgContent.slice(0, comment.contentStart) + escapeXmlText(text) + svgContent.slice(comment.contentEnd);
}

/**
 * Removes `commentId`. Removing the last comment in a list leaves an empty
 * `<comot:comments></comot:comments>` behind — the container is never
 * deleted, same as `setSlideNotes` clearing (not removing) `<comot:notes>`.
 * Unknown `commentId` throws `CoMotionNotFoundError`.
 */
export function deleteSlideComment(svgContent: string, commentId: string): string {
  const roots = scanDocument(svgContent);
  const svgRoot = requireSvgRoot(roots);
  const comment = findComment(svgRoot, commentId);
  return svgContent.slice(0, comment.start) + svgContent.slice(comment.end);
}
