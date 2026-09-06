import { parseClipboardSvg } from "@co-motion/core/clipboard";

/**
 * Classifies whatever text a `paste` event (or `navigator.clipboard.readText()`)
 * handed the app — the front half of [E2.T18]'s paste behaviour table (計畫
 * §4.3). A malformed co-motion-looking payload is NOT this module's concern:
 * `parseClipboardSvg` already returns `null` (not a throw) for anything that
 * merely fails to parse as XML — `sanitizeClipboardMarkup`'s throws only
 * happen once `pasteElements` actually tries to splice a *recognised*
 * payload, several steps downstream of this classification.
 */
export type ClipboardTextKind =
  | { kind: "empty" }
  | { kind: "co-motion-elements"; svg: string }
  | { kind: "plain"; text: string };

export function classifyClipboardText(text: string | null | undefined): ClipboardTextKind {
  if (!text || text.trim() === "") {
    return { kind: "empty" };
  }
  if (parseClipboardSvg(text)) {
    return { kind: "co-motion-elements", svg: text };
  }
  return { kind: "plain", text };
}
