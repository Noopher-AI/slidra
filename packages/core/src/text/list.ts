import { CoMotionError } from "../errors.js";

/**
 * `data-comot-list` token kind (NOOP-65 決定 E), one per paragraph.
 * Extracted out of `element-text.ts` (NOOP-65r3) so a host-side reader —
 * `canvas.ts`'s preview channel — can turn a raw `data-comot-list` string
 * plus a paragraph count into the same `indents` `wrapText` needs, without
 * needing a `ScannedNode` (which only exists on the core side of the
 * `parseSlide()` boundary). This is the single source of truth for both
 * sides; `element-text.ts`'s `readListTokens`/`indentsForTokens` are thin
 * wrappers around the two functions below, not a second implementation.
 */
export type ListKind = "bullet" | "number" | "none";

const LIST_KINDS: readonly ListKind[] = ["bullet", "number", "none"];

/** Left indent, in em (× font-size), for a list paragraph — a judgement value (no ADR/ticket names one); tune by changing this one constant. */
export const LIST_INDENT_EM = 1.5;

/**
 * Parses a text box's `data-comot-list` attribute value (`raw`, `null`
 * when the attribute is absent) into exactly `paragraphCount` tokens, one
 * per paragraph. A paragraph with no token — because the attribute is
 * absent, empty, or has fewer tokens than paragraphs — defaults to
 * `"none"` (NOOP-65 §4.5 compatibility: a legacy box with no attribute at
 * all reads as "no list anywhere", byte-for-byte the pre-list behaviour).
 */
export function parseListTokens(raw: string | null, paragraphCount: number, elementId: string): ListKind[] {
  const tokens = raw === null || raw.trim() === "" ? [] : raw.trim().split(/\s+/);
  for (const token of tokens) {
    if (!LIST_KINDS.includes(token as ListKind)) {
      throw new CoMotionError(`元素 ${elementId} 的 data-comot-list 含不合法的值：${token}`);
    }
  }
  return Array.from({ length: paragraphCount }, (_, i) => (tokens[i] as ListKind | undefined) ?? "none");
}

/** `wrapText`'s `indents` option, one entry per paragraph — non-"none" paragraphs get `LIST_INDENT_EM * fontSize`, everything else 0. */
export function listIndents(tokens: readonly ListKind[], fontSizePx: number): number[] {
  return tokens.map((kind) => (kind === "none" ? 0 : LIST_INDENT_EM * fontSizePx));
}
