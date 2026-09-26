// Builds the `srcdoc` documents slides render in. Slide content is
// untrusted (spec §19): it always renders inside
// `<iframe sandbox="allow-scripts">` — an opaque origin, never
// `allow-same-origin` — and a Content-Security-Policy lets only the
// viewer's own runtime run, by nonce. The slide's own `<script>` elements,
// `on*` handlers and `javascript:` URLs never execute.

const VIEWPORT_STYLE = "<style>html,body{height:100%;margin:0;overflow:hidden}svg{display:block;width:100%;height:100%}</style>";

/**
 * The frame's CSP. Network images, media and fonts stay blocked (format
 * §13, §17) until the viewer allows them for the deck (`allowRemote`).
 */
function policy(nonce, allowRemote = false) {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  const network = allowRemote ? " https:" : "";
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${script}; ` +
    `style-src 'unsafe-inline'; img-src data:${network}; media-src data:${network}; font-src data:${network}">`
  );
}

function freshNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** `@font-face` rules for every font the deck embeds (spec §8), sources inlined, as CSS text. */
export function fontFaceCss(deck) {
  return deck.fonts
    .filter((font) => deck.hasFile(font.file))
    .map((font) => {
      const format = /\.otf$/i.test(font.file) ? "opentype" : /\.woff2$/i.test(font.file) ? "woff2" : /\.woff$/i.test(font.file) ? "woff" : "truetype";
      const family = font.family.replace(/["\\<>]/g, "");
      return `@font-face{font-family:"${family}";src:url("${deck.dataUrl(font.file)}") format("${format}");font-display:block}`;
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
export function staticDocument(markup, fonts, { lang = null, allowRemote = false } = {}) {
  return `<!doctype html><html${langAttribute(lang)}><head><meta charset="utf-8">${policy(null, allowRemote)}${fonts}${VIEWPORT_STYLE}</head><body style="background:#fff">${markup}</body></html>`;
}

/**
 * The play document. The hide style sits in `<head>` so pre-hidden targets
 * are hidden while parsing — no flash of the full slide. The plan travels
 * as a JSON *string* parsed inside the frame (a bare object literal would
 * treat an untrusted `"__proto__"` id specially), with every `<` escaped so
 * no id can change the HTML tokenizer's state. The runtime comes last, after
 * the slide markup, so every element already exists when it runs.
 */
export function playDocument(markup, fonts, plan, startStep, runtimeSource, { lang = null, allowRemote = false } = {}) {
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
    `<!doctype html><html${langAttribute(lang)}><head><meta charset="utf-8">${policy(nonce, allowRemote)}${fonts}${VIEWPORT_STYLE}${hideStyle}${morphHold}</head>` +
    `<body style="background:${bodyBackground}">${markup}<script nonce="${nonce}">${planScript}</script>` +
    `<script nonce="${nonce}">${runtime}</script></body></html>`
  );
}
