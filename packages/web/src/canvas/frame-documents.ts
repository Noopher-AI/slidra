// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import playerRuntimeSource from "../player-runtime.js?raw";
import selectionRuntimeSource from "../selection-runtime.js?raw";

/**
 * `@font-face` for the presentation font every `.slidra` embeds (ticket
 * #71), injected into every srcdoc `<head>` below so a slide's
 * `font-family="Noto Sans TC"` renders from the font the container ships,
 * not whatever "Noto Sans TC" happens to resolve to (or not) on the host
 * OS. `url()` is an absolute `/api/raw/` path, not relative to `<base>`, so
 * it resolves the same regardless of which wrap function's `baseHref` is in
 * effect. The srcdoc document is an opaque origin, so this fetch is
 * cross-origin even though it targets this same server — see the
 * `Access-Control-Allow-Origin` header serve.ts adds to every `/api/raw/`
 * response for why that still works.
 */
const DEFAULT_PRESENTATION_FONT_FACE_STYLE =
  '<style>@font-face{font-family:"Noto Sans TC";src:url("/api/raw/fonts/NotoSansTC-Presentation.ttf") format("truetype");font-weight:400;font-style:normal;}</style>';

/**
 * The faces actually injected, rebuilt from `project.json` whenever the
 * presentation loads (#305). This used to be the constant above, naming
 * one family — so a deck that imported a second font (`slidra font
 * import`, e.g. `Noto Serif TC` for its titles) rendered that font from
 * whatever the host OS happened to have, on screen and in the PDF alike.
 * The container ships the bytes; every document that shows a slide must
 * declare them.
 *
 * Module-level rather than a parameter threaded through four wrap
 * functions and their callers: it is one fact about the open
 * presentation, exactly as the constant it replaces was one fact about
 * every presentation.
 */
let presentationFontFaceStyle = DEFAULT_PRESENTATION_FONT_FACE_STYLE;

/**
 * Declares the presentation's own embedded fonts for every slide document
 * created from here on. Callers that build slide documents outside this
 * module's own load path (overview, export) call this after reading
 * `/api/presentation`. An empty or missing list keeps the default face, so
 * a deck whose `project.json` predates the `fonts` field still renders.
 */
/** The `<style>` block every slide document injects — see `setPresentationFonts`. */
export function presentationFontFaces(): string {
  return presentationFontFaceStyle;
}

export function setPresentationFonts(fonts: { file: string; family: string }[] | undefined): void {
  if (fonts === undefined || fonts.length === 0) {
    presentationFontFaceStyle = DEFAULT_PRESENTATION_FONT_FACE_STYLE;
    return;
  }
  const faces = fonts
    .map(
      (font) =>
        `@font-face{font-family:"${font.family.replace(/["\\]/g, "")}";src:url("/api/raw/${encodeURI(font.file)}") format("truetype");font-weight:400;font-style:normal;}`,
    )
    .join("");
  presentationFontFaceStyle = `<style>${faces}</style>`;
}

/**
 * (F-01, NOOP-355 #287) An inline `<svg>` is a replacement element with a
 * baseline gap below it, same as `<img>`: at the default `display:inline`
 * it sits a few pixels short of the document's full height, which is
 * exactly the sliver that shows up as a scrollbar on the srcdoc document.
 * `overview.ts`'s thumbnail wrapper already fixed this the same way
 * (`svg{display:block}`); this is that same shape, extended with
 * `overflow:hidden` so nothing inside the slide markup itself (e.g. a
 * stroke that bleeds a fraction of a pixel past the viewBox) can push a
 * scrollbar onto these three documents either. Colour is deliberately
 * absent here — `background`/`color` on body stays in each wrapper's own
 * inline `style=""` attribute, unmodified (design-contract.test.ts only
 * allows `#fff` as a literal in this file; play-grid-css-tokens.test.ts's
 * C1 forbids `.slide-frame` itself from ever getting a `background`).
 */
const SLIDE_VIEWPORT_STYLE = "<style>html,body{height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>";

/**
 * Wraps the fetched slide markup for `srcdoc`. When `baseHref` is given, a
 * `<base>` element is injected so the browser's own relative-URL resolution
 * — not a regex rewrite of untrusted markup (ADR-0011) — turns a slide
 * reference like `href="../assets/photo.png"` into the byte-preserving
 * `/api/raw/` route's path for it. A `srcdoc` document otherwise resolves
 * relative URLs against the *parent* document's URL, which is why a
 * relative asset reference needs this at all. `<base>` alone needs no
 * sandbox token: subresource loads (`<img>`, `<video>`) from an
 * opaque-origin document to this origin are not blocked by `sandbox`.
 *
 * The `<base>` does NOT disturb same-document fragment references
 * (`url(#grad)`, `<use href="#sym">` and friends) — measured, not assumed,
 * on all three engines by e2e/base-fragment-spike.test.ts, which is why
 * this and wrapPlayDocument/slideDirectory are exported.
 *
 * `background:#fff` on `<body>` (#120): a slide with no background rect of
 * its own (e.g. `slidra new`'s blank title slide) otherwise leaves this
 * document fully transparent. This function's own callers only ever render
 * inside a black loading/error placeholder (the empty-deck message and
 * renderPlay()'s parse-error fallback, both painted over play.css's `.canvas`
 * `#000`), so a transparent document there reads as solid black instead of a
 * blank page.
 */
/**
 * The document put into the iframe when there are no slides at all:
 * entirely empty, with a **transparent background**.
 *
 * The previous version went through `wrapSlideDocument`, so a presentation
 * with no slides yet showed a blank 16:9 white sheet on the stage (that
 * wrapper function's body hardcodes `background:#fff`), which looked like
 * "there's one blank slide" — when actually there are none at all. With
 * transparency, the dark well underneath shows through directly, and "no
 * slides right now" is instead said by the parent document's
 * `.stage-empty` in white text (Stage.tsx), so the font size and color can
 * pick up the shell's design tokens.
 */
const EMPTY_DECK_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent"></body></html>';

export function wrapSlideDocument(bodyMarkup: string, baseHref?: string): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${presentationFontFaceStyle}${SLIDE_VIEWPORT_STYLE}</head><body style="margin:0;background:#fff">${bodyMarkup}</body></html>`;
}

/**
 * Wraps the fetched slide markup for view mode's `srcdoc` (ADR-0007/#56):
 * same shape as wrapSlideDocument, plus selection-runtime.js injected as a
 * second `<script>`, seeded with the accent/handle colours the parent read
 * from its own tokens.css (selectionColors() above) — the opaque-origin
 * document this becomes has no access to that `:root` itself.
 *
 * Deliberately a separate function rather than a new parameter on
 * wrapSlideDocument: that function's signature is depended on by
 * e2e/base-fragment-spike.test.ts, and — more importantly — it is also
 * still used for the play-mode fallback path (renderPlay()'s `catch`
 * branch) and the empty-deck placeholder, neither of which may ever
 * acquire a selection runtime.
 *
 * Colour values are computed CSS strings, never anything an author
 * controls, but they still get the same `<` escaping wrapPlayDocument's
 * planScript needs (see that function's own comment for why a bare
 * `</script` guard is not enough) — cheap insurance against a future
 * token value that happens to contain one.
 *
 * The runtime's two `<script>` tags come BEFORE `bodyMarkup`, not after
 * (unlike wrapPlayDocument, which deliberately puts its runtime last).
 * `document.body` already exists by the time an inline script that is
 * body's first child runs, so `document.body.appendChild(host)` inside
 * selection-runtime.js still works. What this ordering buys: the
 * runtime's capturing `window` click listener registers before any slide
 * script gets a chance to run. A hostile slide can call
 * `stopImmediatePropagation()` from its own capturing `window` listener,
 * which kills every other listener on that same target (`window`) — ours
 * included — regardless of phase. Registering first is the only thing
 * that makes ours win that race; putting the runtime after `bodyMarkup`
 * (or leaving the listener on `document`, which capture never even
 * reaches before `window`) reopens exactly the silent-selection-death
 * hole this ordering exists to close (gate round 2, #56). Do not
 * "simplify" this back to matching wrapPlayDocument's order.
 */
export function wrapSelectionDocument(
  bodyMarkup: string,
  baseHref: string | undefined,
  colors: { accent: string; handle: string },
  /**
   * [E2.T17] plan §4.4: `stageMediaFor(bodyMarkup)`'s own return value —
   * computed by the CALLER (render(), which already has `bodyMarkup` in
   * hand before calling this function), not derived again in here, so this
   * function stays a pure "given everything it needs, produce a document"
   * wrapper, same shape as its `colors` parameter.
   */
  media: Record<string, { src: string; kind: "video" | "audio" }>,
  /** [E2.T17]: ids of the slide's third-party embeds — the runtime measures these and posts their boxes out, nothing more. Same caller-computes-it contract as `media`. */
  embedIds: string[],
): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  const safeColorsJson = JSON.stringify(colors).replace(/</g, "\\u003C");
  // Same `__proto__`-safety reasoning as renderPlanScript() in
  // player-plan.ts: `media` is keyed by untrusted SVG element ids
  // (ADR-0007), and JSON.parse (not a bare object literal) is what keeps a
  // "__proto__" key a genuine own property on the far side of the wire.
  const safeMediaJson = JSON.stringify(JSON.stringify(media)).replace(/</g, "\\u003C");
  const safeEmbedIdsJson = JSON.stringify(JSON.stringify(embedIds)).replace(/</g, "\\u003C");
  // `background:#fff` (#120), same as the other two wrappers: view mode
  // used to lean on `.stage`'s white background for slides that paint no
  // background of their own — stage.css no longer has one (it caused a 1px
  // seam), so the document must be opaque white by itself.
  //
  // `user-select:none` (NOOP-349): a slide is a canvas of objects to
  // manipulate, and the browser's own text selection has no role in it —
  // text is edited through the runtime's hidden textarea (ensureTextarea in
  // selection-runtime.js), never by selecting glyphs in the SVG. Left at the
  // default `auto`, dragging a marquee ALSO ran a native text selection, and
  // native selection walks DOCUMENT ORDER rather than the dragged rectangle:
  // marqueeing the three body lines highlighted the title as well, because
  // the title's text node sits before them in the document even though the
  // rectangle never touched it. The app's own selection was right (3
  // elements); the extra highlight was the browser's. Note this reproduces
  // only under a real pointer — CDP-synthesised drags never start a native
  // selection, so no qa/cases script or e2e test can catch a regression here.
  // Applied to this wrapper only: play mode is a separate document where
  // letting a viewer select text is a different decision.
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${presentationFontFaceStyle}${SLIDE_VIEWPORT_STYLE}</head><body style="margin:0;background:#fff;user-select:none;-webkit-user-select:none"><script>window.__SLIDRA_SELECTION_COLORS__=${safeColorsJson};window.__SLIDRA_SELECTION_MEDIA__=JSON.parse(${safeMediaJson});window.__SLIDRA_SELECTION_EMBEDS__=JSON.parse(${safeEmbedIdsJson});<\/script><script>${selectionRuntimeSource}<\/script>${bodyMarkup}</body></html>`;
}

/**
 * Wraps the fetched slide markup for play mode's `srcdoc`. The hide style
 * lives in `<head>` so the browser applies it while parsing, before any
 * script runs — the runtime never hides anything on DOMContentLoaded,
 * which would flash the full slide first. The runtime script comes last in
 * `<body>`, after the slide markup, so `document.getElementById` inside it
 * can find every element immediately without waiting for an event.
 *
 * `background:#fff` on `<body>` (#120): this is play mode's normal
 * rendering path (renderPlay()'s non-error branch), painted over play.css's
 * `.canvas` `#000` loading placeholder. A slide with no background rect of
 * its own (e.g. `slidra new`'s blank title slide) otherwise leaves this
 * document transparent, so the black placeholder never gets covered — the
 * whole point of #000 there (avoid a flash of white before content paints)
 * regresses into the opposite failure: a flash of black that never clears.
 */
export function wrapPlayDocument(bodyMarkup: string, baseHref: string, hideStyle: string, planScript: string): string {
  const baseTag = `<base href="${escapeAttribute(baseHref)}">`;
  // planScript is built from parsed slide attributes (target ids, effect
  // names) — untrusted content (ADR-0007), and it lands inside a raw
  // <script> element, not an HTML text node, so HTML-entity escaping
  // (escapeAttribute's job, above) does not apply here at all. Escaping
  // only a literal "</script" (an earlier version of this function) is
  // not enough: a target containing "<!--<script>" drives the HTML
  // tokenizer into "script data double escaped" state, where the very
  // "</script>" text this function writes to close the tag no longer
  // counts as a real closing tag — the parser keeps consuming straight
  // through the runtime's own <script> below, and play mode never starts
  // (found in gate review round 3). Every `<` inside planScript can only
  // ever occur inside a quoted JSON string value (JSON's own structural
  // characters never include "<"), so replacing all of them with the
  // equivalent JSON/JS string escape `<` is unconditionally safe —
  // it cannot land outside a string literal — and removes every foothold
  // for a tokenizer state change, not just the one this function used to
  // special-case.
  const safePlanScript = planScript.replace(/</g, "\\u003C");
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${presentationFontFaceStyle}${SLIDE_VIEWPORT_STYLE}${hideStyle}</head><body style="margin:0;background:#fff">${bodyMarkup}<script>${safePlanScript}<\/script><script>${playerRuntimeSource}<\/script></body></html>`;
}

/** The virtual directory a slide lives in, percent-encoded per segment. */
export function slideDirectory(slidePath: string): string {
  const lastSlash = slidePath.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return slidePath
    .slice(0, lastSlash + 1)
    .split("/")
    .map((segment) => (segment === "" ? segment : encodeURIComponent(segment)))
    .join("/");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`failed to load: ${path}`);
  }
  return (await response.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`failed to load: ${path}`);
  }
  return response.text();
}

export { EMPTY_DECK_DOCUMENT, fetchJson, fetchText };
