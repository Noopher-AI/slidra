import { test } from "node:test";
import assert from "node:assert/strict";
import { fontFaceStyle, isCssColor, langAttribute, playDocument, staticDocument } from "../lib/viewer/frame.js";
import { sanitizeSnapshot, transitionTransform } from "../lib/viewer/player.js";

const plan = (extra = {}) => ({ steps: [], hidden: [], hideSelectors: {}, media: {}, stageMedia: {}, embedIds: [], ...extra });
const csp = (html) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];

test("the play document's CSP admits only the runtime, by a fresh nonce (format §17)", () => {
  const a = playDocument("<svg/>", "", plan(), -1, "/*runtime*/");
  const b = playDocument("<svg/>", "", plan(), -1, "/*runtime*/");
  assert.match(csp(a), /^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/]{22}=='; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:$/);
  assert.notEqual(csp(a), csp(b), "every document gets its own nonce");
  const nonce = /'nonce-([^']+)'/.exec(csp(a))[1];
  assert.equal((a.match(new RegExp(`<script nonce="${nonce.replace(/[+/]/g, "\\$&")}">`, "g")) ?? []).length, 2, "the plan and the runtime, nothing else");
});

test("network images, media and fonts are blocked until the deck is allowed them (format §13)", () => {
  assert.doesNotMatch(csp(playDocument("<svg/>", "", plan(), -1, "")), /https:/);
  assert.match(csp(playDocument("<svg/>", "", plan(), -1, "", { allowRemote: true })), /img-src data: https:; media-src data: https:; font-src data: https:$/);
  assert.doesNotMatch(csp(staticDocument("<svg/>", "")), /https:/);
  assert.match(csp(staticDocument("<svg/>", "", { allowRemote: true })), /img-src data: https:/);
});

test("the static document runs no script at all", () => {
  const html = staticDocument("<svg/>", "");
  assert.match(csp(html), /script-src 'none'/);
  assert.doesNotMatch(html, /<script/);
});

test("untrusted ids cannot break out of the plan script or the hide style", () => {
  const evil = "x</script><script>alert(1)</script>";
  const html = playDocument("<svg/>", "", plan({ hidden: [evil], hideSelectors: { [evil]: "#x\\3c /style" }, steps: [{ effects: [{ target: evil }] }] }), -1, "</script>");
  assert.equal((html.match(/<\/script>/gi) ?? []).length, 2, "only the two closing tags the frame writes itself");
  assert.doesNotMatch(html, /<script>alert/);
  const planScript = /window\.__SLIDRA_PLAN__=JSON\.parse\((.*?)\);<\/script>/s.exec(html)[1];
  assert.doesNotMatch(planScript, /</, "every < in the plan is escaped");
  assert.match(html, /<style id="slidra-hide">#x\\3c \/style\{opacity:0 !important\}<\/style>/);
  const inlined = JSON.parse(JSON.parse(planScript.replace(/\\u003C/g, "<")));
  assert.equal(inlined.hidden[0], evil, "the plan survives the round trip exactly");
});

test("a morph document holds its first paint over the outgoing background", () => {
  const html = playDocument("<svg/>", "", plan({ morph: { duration: 1, from: {}, ghosts: "", background: "rgb(16, 20, 24)" } }), -1, "");
  assert.match(html, /<style id="slidra-morph-hold">body>svg\{visibility:hidden\}<\/style>/);
  assert.match(html, /<body style="background:rgb\(16, 20, 24\)">/);
  const hostile = playDocument("<svg/>", "", plan({ morph: { duration: 1, from: {}, ghosts: "", background: 'red"><script>alert(1)</script>' } }), -1, "");
  assert.match(hostile, /<body style="background:#fff">/);
});

test("lang and colour values from the deck are only used when well-formed", () => {
  assert.equal(langAttribute("zh-Hant-TW"), ' lang="zh-Hant-TW"');
  for (const bad of ['en" onload="x', "", null, 42, "a"]) assert.equal(langAttribute(bad), "", String(bad));
  for (const good of ["#fff", "#10141880", "rgb(1, 2, 3)", "rgba(1,2,3,.5)", "transparent"]) assert.ok(isCssColor(good), good);
  for (const bad of ["red;x", 'rgb(1,2,3)"', "url(x)", "", null]) assert.equal(isCssColor(bad), false, String(bad));
});

test("font faces use the registered family, escaped, and the right format", () => {
  const deck = /** @type {any} */ ({
    fonts: [
      { file: "fonts/A.woff2", family: 'Evil"<Family>\\' },
      { file: "fonts/B.otf", family: "B" },
      { file: "fonts/C.ttf", family: "C" },
      { file: "fonts/missing.ttf", family: "Gone" },
    ],
    hasFile: (file) => file !== "fonts/missing.ttf",
    dataUrl: (file) => `data:font/x;base64,${file}`,
  });
  const style = fontFaceStyle(deck);
  assert.match(style, /font-family:"EvilFamily";src:url\("data:font\/x;base64,fonts\/A\.woff2"\) format\("woff2"\)/);
  assert.match(style, /format\("opentype"\)/);
  assert.match(style, /format\("truetype"\)/);
  assert.doesNotMatch(style, /Gone/);
  assert.equal(fontFaceStyle(/** @type {any} */ ({ fonts: [], hasFile: () => false })), "");
});

test("page transitions start and end where playback §5 says", () => {
  assert.equal(transitionTransform("slide", "enter"), "translateX(8%)");
  assert.equal(transitionTransform("slide", "exit"), "translateX(-8%)");
  assert.equal(transitionTransform("zoom", "enter"), "scale(1.06)");
  assert.equal(transitionTransform("zoom", "exit"), "scale(0.94)");
  assert.equal(transitionTransform("fade", "enter"), "none");
});

test("a snapshot from the slide frame is rebuilt from finite numbers only", () => {
  const clean = sanitizeSnapshot({
    "el-ok": { box: { x: 1, y: 2, width: 3, height: 4 }, matrix: [1, 0, 0, 1, 5, 6], opacity: 1.7, extra: "<script>" },
    "el-nan": { box: { x: NaN, y: 0, width: 1, height: 1 }, matrix: [1, 0, 0, 1, 0, 0], opacity: 1 },
    "el-short": { box: { x: 0, y: 0, width: 1, height: 1 }, matrix: [1, 0, 0], opacity: 1 },
    "el-string": { box: { x: "1", y: 0, width: 1, height: 1 }, matrix: [1, 0, 0, 1, 0, 0], opacity: 1 },
    __proto__: { polluted: true },
  });
  assert.deepEqual(Object.keys(clean), ["el-ok"]);
  assert.deepEqual(clean["el-ok"], { box: { x: 1, y: 2, width: 3, height: 4 }, matrix: [1, 0, 0, 1, 5, 6], opacity: 1 });
  assert.equal(Object.getPrototypeOf(clean), null);
});
