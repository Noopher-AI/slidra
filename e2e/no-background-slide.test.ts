import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { wrapPlayDocument } from "../packages/web/src/canvas.js";
import { wrapSlideDocument as wrapThumbnailDocument } from "../packages/web/src/overview.js";
import { renderHideStyle, renderPlanScript } from "../packages/web/src/player-plan.js";
import { decodePng } from "./helpers/png-pixel.js";

/**
 * Regression test for #120/NOOP-150: a slide with no background rect of
 * its own used to render as solid black in both the overview rail's
 * thumbnails and play mode, because `.overview-thumb`/`.play`'s `#000`
 * loading placeholder (rail.css/shell.css) was never painted over — the
 * wrapped slide document itself had a transparent `html`/`body`. This is
 * not a corner case: `co-motion new`'s own minimal presentation
 * (packages/core/src/presentation.ts's `buildMinimalPresentation`) is
 * exactly this shape, a lone `<text>` with no rect — the fixture below is
 * a literal copy of it.
 *
 * Reproduces the placeholder colour directly (a black container behind a
 * `srcdoc` iframe) rather than driving the full app through a real
 * `serve`, mirroring e2e/base-fragment-spike.test.ts's approach of testing
 * the real wrapper functions (`wrapThumbnailDocument`/`wrapPlayDocument`)
 * over a real http server, without needing a built `packages/web/dist`.
 *
 * Judgement is by an actual decoded pixel a few px in from each frame's
 * corner (away from the slide's own `<text>`, so glyph anti-aliasing never
 * factors into "is this black or white") — a screenshot buffer compared
 * byte-for-byte would tell us "changed", not "black"; decoding to an
 * actual RGB triplet is what makes the assertion trustworthy after a
 * change even the author didn't anticipate.
 */
const NO_BACKGROUND_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
  '<text x="640" y="360" text-anchor="middle" font-size="48">未命名簡報</text>' +
  "</svg>";

const EMPTY_PLAN = { steps: [], hidden: [] };
const PLAN_SCRIPT = renderPlanScript(EMPTY_PLAN);
const HIDE_STYLE = renderHideStyle(EMPTY_PLAN.hidden);

// Container sizing/background mirrors the production placeholder each
// wrapper's iframe sits inside: rail.css's `.overview-thumb` (16:9,
// `background:#000`) and shell.css/play.css's `.play` mode chain
// (`.canvas-area`/`.stage`/`.canvas`, all forced to `background:#000`).
// Pixel dimensions themselves are arbitrary — only the aspect ratio and
// the black backdrop matter here.
const THUMBNAIL_HTML = [
  `<div id="thumb" style="width:160px;height:90px;background:#000;padding:0">`,
  `<iframe class="overview-frame" sandbox="" style="width:100%;height:100%;border:0;display:block" srcdoc="${escapeAttribute(wrapThumbnailDocument(NO_BACKGROUND_SVG))}"></iframe>`,
  `</div>`,
].join("");

const PLAY_HTML = [
  `<div id="play" style="width:400px;height:225px;background:#000;padding:0">`,
  `<iframe class="slide-frame" sandbox="allow-scripts" style="width:100%;height:100%;border:0;display:block" srcdoc="${escapeAttribute(wrapPlayDocument(NO_BACKGROUND_SVG, "/", HIDE_STYLE, PLAN_SCRIPT))}"></iframe>`,
  `</div>`,
].join("");

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

const PAGE_HTML = [
  `<!doctype html><html><head><meta charset="utf-8"></head>`,
  `<body style="margin:0">${THUMBNAIL_HTML}${PLAY_HTML}</body></html>`,
].join("");

describe("無背景矩形的投影片：縮圖與播放模式不再顯示純黑", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    // Real http server, same reasoning as base-fragment-spike.test.ts: a
    // srcdoc document's fallback base URL is its parent's, and `page.goto`
    // (not `setContent`) is what makes that parent URL real.
    server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    browser = await chromium.launch();
    console.log(`瀏覽器：Chromium ${browser.version()}`);
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  afterEach(async () => {
    await page?.close();
  });

  async function gotoSpikePage(): Promise<void> {
    page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    const { port } = server.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${port}/`);
    // Both iframes must have finished parsing their SVG before any pixel
    // is judged (hand poll: expect.poll is not usable outside a `it`, and
    // this helper is shared by more than one test).
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [thumbReady, playReady] = await Promise.all([
        page.frameLocator("#thumb iframe").locator("svg").count(),
        page.frameLocator("#play iframe").locator("svg").count(),
      ]);
      if (thumbReady === 1 && playReady === 1) break;
      await page.waitForTimeout(100);
    }
    // One extra beat so paint settles (same margin base-fragment-spike uses).
    await page.waitForTimeout(500);
  }

  it("縮圖（overview.ts 的 wrapSlideDocument）在無背景矩形的投影片上畫出白底，不是黑色佔位色", async () => {
    await gotoSpikePage();
    const png = decodePng(await page.locator("#thumb").screenshot());
    // A few px in from the corner: inside the iframe's painted area, far
    // from the centred <text> so glyph anti-aliasing never enters the
    // sample.
    const pixel = png.getPixel(5, 5);
    expect(pixel.r, `角落像素應為白色，實際 rgb(${pixel.r},${pixel.g},${pixel.b})`).toBeGreaterThan(200);
    expect(pixel.g).toBeGreaterThan(200);
    expect(pixel.b).toBeGreaterThan(200);
  });

  it("播放模式（canvas.ts 的 wrapPlayDocument）在無背景矩形的投影片上畫出白底，不是黑色佔位色", async () => {
    await gotoSpikePage();
    const png = decodePng(await page.locator("#play").screenshot());
    const pixel = png.getPixel(5, 5);
    expect(pixel.r, `角落像素應為白色，實際 rgb(${pixel.r},${pixel.g},${pixel.b})`).toBeGreaterThan(200);
    expect(pixel.g).toBeGreaterThan(200);
    expect(pixel.b).toBeGreaterThan(200);
  });
});
