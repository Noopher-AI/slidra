/**
 * Same marker core's `element-clipboard.ts` writes onto a
 * copied selection's root `<svg>` and reads back to recognise one
 * (`CLIPBOARD_MARKER_ATTR`/`_VALUE`) — duplicated here rather than
 * imported (F8, NOOP-289 決定 C1): the web bundle no longer depends on
 * core at all.
 */
const CLIPBOARD_MARKER_ATTR = "data-comot-clipboard";
const CLIPBOARD_MARKER_VALUE = "elements";

/**
 * Classifies whatever text a `paste` event (or `navigator.clipboard.readText()`)
 * handed the app — the front half of [E2.T18]'s paste behaviour table (計畫
 * §4.3). Recognition is deliberately shallow: only the root `<svg>`'s own
 * marker attribute is checked with the browser's native `DOMParser` —
 * `sourceSlidePath`/`viewBox`/sanitize-worthy content are NOT this module's
 * concern any more (決定 C1/(d)): a payload that looks like comotion
 * clipboard content but is actually malformed (e.g. carries `onload`) is
 * still classified as `comotion-elements` and sent straight through to
 * `element paste`, which the CLI's own three-layer validation rejects —
 * the browser never sanitizes.
 */
export type ClipboardTextKind =
  | { kind: "empty" }
  | { kind: "comotion-elements"; svg: string }
  | { kind: "plain"; text: string };

function isCoMotionClipboardSvg(text: string): boolean {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length === 0) {
    const root = doc.documentElement;
    return !!root && root.localName.toLowerCase() === "svg" && root.getAttribute(CLIPBOARD_MARKER_ATTR) === CLIPBOARD_MARKER_VALUE;
  }
  // DOMParser rejected the WHOLE document — e.g. a raw unescaped "<" inside
  // a descendant's attribute value (illegal XML), well past the root
  // `<svg>` tag itself. This must not be silently reclassified as "plain
  // text" and dropped: decision (d)/(c1) requires malformed-but-
  // clipboard-shaped content to still reach `element paste`, so the CLI's
  // own three-layer validation is what visibly rejects it — the browser
  // never sanitizes. A loose textual check on just the root tag's own
  // opening substring (the part that, by construction, parsed fine — the
  // failure is always deeper in) is enough to tell "meant to be a
  // comotion payload" apart from some other broken SVG.
  const rootTagMatch = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b[^>]*>/.exec(text);
  return !!rootTagMatch && rootTagMatch[0].includes(`${CLIPBOARD_MARKER_ATTR}="${CLIPBOARD_MARKER_VALUE}"`);
}

export function classifyClipboardText(text: string | null | undefined): ClipboardTextKind {
  if (!text || text.trim() === "") {
    return { kind: "empty" };
  }
  if (isCoMotionClipboardSvg(text)) {
    return { kind: "comotion-elements", svg: text };
  }
  return { kind: "plain", text };
}
