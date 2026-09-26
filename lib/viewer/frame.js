// Builds the `srcdoc` documents slides render in. Slide content is
// untrusted (spec §19): it always renders inside
// `<iframe sandbox="allow-scripts">` — an opaque origin, never
// `allow-same-origin` — and a Content-Security-Policy lets only the
// viewer's own runtime run, by nonce. The slide's own `<script>` elements,
// `on*` handlers and `javascript:` URLs never execute.

const VIEWPORT_STYLE = "<style>html,body{height:100%;margin:0;overflow:hidden}svg{display:block;width:100%;height:100%}</style>";

/**
 * The frame's CSP. Network images, media and fonts stay blocked (format
 * §13, §17) until the viewer allows them for the deck (`allowRemote`). The
 * deck's own files, when its source serves them at URLs (lib/viewer/source.js),
 * are admitted one by one: `files` are those URLs, and only they load.
 */
function policy(nonce, allowRemote = false, files = []) {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  const sources = [...(allowRemote ? ["https:"] : []), ...sourceExpressions(files)].map((source) => ` ${source}`).join("");
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${script}; ` +
    `style-src 'unsafe-inline'; img-src data:${sources}; media-src data:${sources}; font-src data:${sources}">`
  );
}

/**
 * CSP source expressions admitting exactly the given file URLs: an
 * `http(s):` URL becomes its origin and path (a CSP source cannot name a
 * query), a `blob:` URL the `blob:` scheme (a blob URL cannot be named
 * one by one), and `data:` needs nothing (it is always allowed). Anything
 * else is left out.
 * @param {string[]} urls
 * @returns {string[]}
 */
export function sourceExpressions(urls) {
  const out = new Set();
  for (const value of urls) {
    if (typeof value !== "string" || /^data:/i.test(value)) continue;
    if (/^blob:/i.test(value)) {
      out.add("blob:");
      continue;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    // `;` and `,` separate directives and policies; whitespace separates sources. The rest of a URL path is a valid CSP path.
    const path = url.pathname.replace(/[;,\s"'<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
    out.add(url.origin + path);
  }
  return [...out];
}

function freshNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** `@font-face` rules for every font the deck embeds (spec §8), sources inlined, as CSS text. */
export function fontFaceCss(deck) {
  return fontFaceRules(deck.fonts.filter((font) => deck.hasFile(font.file)).map((font) => ({ ...font, url: deck.dataUrl(font.file) })));
}

/**
 * `@font-face` rules for fonts that load from `url` (a `data:` URL, or a
 * deck source's file URL), as CSS text.
 * @param {{ family: string, file: string, url: string }[]} fonts
 */
export function fontFaceRules(fonts) {
  return fonts
    .map((font) => {
      const format = /\.otf$/i.test(font.file) ? "opentype" : /\.woff2$/i.test(font.file) ? "woff2" : /\.woff$/i.test(font.file) ? "woff" : "truetype";
      const family = font.family.replace(/["\\<>]/g, "");
      const url = font.url.replace(/["\\<>)\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
      return `@font-face{font-family:"${family}";src:url("${url}") format("${format}");font-display:block}`;
    })
    .join("");
}

/** The same rules as a `<style>` element for a frame document. */
export function fontFaceStyle(deck) {
  const css = fontFaceCss(deck);
  return css ? `<style>${css}</style>` : "";
}

/** `<html lang>` for a slide's language, when it is a well-formed BCP 47 tag (it comes from untrusted markup). */
export function langAttribute(lang) {
  return typeof lang === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? ` lang="${lang}"` : "";
}

/** A computed CSS colour as the runtime reports it (`rgb(…)`, `rgba(…)`, `#…`, a keyword) — never anything that could close the attribute. */
export function isCssColor(value) {
  return typeof value === "string" && /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|[a-z]+)$/i.test(value.trim());
}

/** A slide with no runtime at all: thumbnails, and the fallback for a slide whose effect list is broken. */
export function staticDocument(markup, fonts, { lang = null, allowRemote = false, files = [] } = {}) {
  return `<!doctype html><html${langAttribute(lang)}><head><meta charset="utf-8">${policy(null, allowRemote, files)}${fonts}${VIEWPORT_STYLE}</head><body style="background:#fff">${markup}</body></html>`;
}

/**
 * The play document. The hide style sits in `<head>` so pre-hidden targets
 * are hidden while parsing — no flash of the full slide. The plan travels
 * as a JSON *string* parsed inside the frame (a bare object literal would
 * treat an untrusted `"__proto__"` id specially), with every `<` escaped so
 * no id can change the HTML tokenizer's state. The runtime comes last, after
 * the slide markup, so every element already exists when it runs.
 * `files` are the deck source's file URLs the markup and fonts load.
 */
export function playDocument(markup, fonts, plan, startStep, runtimeSource, { lang = null, allowRemote = false, files = [] } = {}) {
  const nonce = freshNonce();
  const hideRules = plan.hidden.map((id) => `${plan.hideSelectors[id]}{opacity:0 !important}`).join("");
  const hideStyle = `<style id="slidra-hide">${hideRules}</style>`;
  // A morph's first frame is drawn by the runtime; until then the slide stays undrawn over the outgoing background.
  const morphHold = plan.morph ? '<style id="slidra-morph-hold">body>svg{visibility:hidden}</style>' : "";
  const bodyBackground = plan.morph && isCssColor(plan.morph.background) ? plan.morph.background : "#fff";
  const planJson = JSON.stringify({ ...plan, startStep });
  const planScript = `window.__SLIDRA_PLAN__=JSON.parse(${JSON.stringify(planJson)});`.replace(/</g, "\\u003C");
  const runtime = runtimeSource.replace(/<\/script/gi, "<\\/script");
  return (
    `<!doctype html><html${langAttribute(lang)}><head><meta charset="utf-8">${policy(nonce, allowRemote, files)}${fonts}${VIEWPORT_STYLE}${hideStyle}${morphHold}</head>` +
    `<body style="background:${bodyBackground}">${markup}<script nonce="${nonce}">${planScript}</script>` +
    `<script nonce="${nonce}">${runtime}</script></body></html>`
  );
}
