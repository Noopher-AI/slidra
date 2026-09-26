// Builds the `srcdoc` documents slides render in. Slide content is
// untrusted (spec §19): it always renders inside
// `<iframe sandbox="allow-scripts">` — an opaque origin, never
// `allow-same-origin` — and a Content-Security-Policy lets only the
// viewer's own runtime run, by nonce. The slide's own `<script>` elements,
// `on*` handlers and `javascript:` URLs never execute.

const VIEWPORT_STYLE = "<style>html,body{height:100%;margin:0;overflow:hidden}svg{display:block;width:100%;height:100%}</style>";

function policy(nonce) {
  const script = nonce ? `'nonce-${nonce}'` : "'none'";
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${script}; ` +
    "style-src 'unsafe-inline'; img-src data: https:; media-src data: https:; font-src data:\">"
  );
}

function freshNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** `@font-face` rules for every font the deck embeds (spec §8), sources inlined. */
export function fontFaceStyle(deck) {
  const faces = deck.fonts
    .filter((font) => deck.hasFile(font.file))
    .map((font) => {
      const format = /\.otf$/i.test(font.file) ? "opentype" : /\.woff2$/i.test(font.file) ? "woff2" : /\.woff$/i.test(font.file) ? "woff" : "truetype";
      const family = font.family.replace(/["\\<>]/g, "");
      return `@font-face{font-family:"${family}";src:url("${deck.dataUrl(font.file)}") format("${format}");font-display:block}`;
    })
    .join("");
  return faces ? `<style>${faces}</style>` : "";
}

/** A slide with no runtime at all: thumbnails, and the fallback for a slide whose effect list is broken. */
export function staticDocument(markup, fonts) {
  return `<!doctype html><html><head><meta charset="utf-8">${policy(null)}${fonts}${VIEWPORT_STYLE}</head><body style="background:#fff">${markup}</body></html>`;
}

/**
 * The play document. The hide style sits in `<head>` so pre-hidden targets
 * are hidden while parsing — no flash of the full slide. The plan travels
 * as a JSON *string* parsed inside the frame (a bare object literal would
 * treat an untrusted `"__proto__"` id specially), with every `<` escaped so
 * no id can change the HTML tokenizer's state. The runtime comes last, after
 * the slide markup, so every element already exists when it runs.
 */
export function playDocument(markup, fonts, plan, startStep, runtimeSource) {
  const nonce = freshNonce();
  const hideRules = plan.hidden.map((id) => `${plan.hideSelectors[id]}{opacity:0 !important}`).join("");
  const hideStyle = `<style id="slidra-hide">${hideRules}</style>`;
  const planJson = JSON.stringify({ ...plan, startStep });
  const planScript = `window.__SLIDRA_PLAN__=JSON.parse(${JSON.stringify(planJson)});`.replace(/</g, "\\u003C");
  const runtime = runtimeSource.replace(/<\/script/gi, "<\\/script");
  return (
    `<!doctype html><html><head><meta charset="utf-8">${policy(nonce)}${fonts}${VIEWPORT_STYLE}${hideStyle}</head>` +
    `<body style="background:#fff">${markup}<script nonce="${nonce}">${planScript}</script>` +
    `<script nonce="${nonce}">${runtime}</script></body></html>`
  );
}
