import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { wrapSlideDocument, wrapPlayDocument, slideDirectory } from "../packages/web/src/canvas.js";
import { wrapSlideDocument as wrapThumbnailDocument } from "../packages/web/src/overview.js";
import { renderHideStyle, renderPlanScript } from "../packages/web/src/player-plan.js";

/**
 * `<base>` 與同文件片段參照實測（外部審查對 overview.ts 提出，實為 canvas.ts
 * 與 overview.ts 共同的問題）。A spike in the exact shape of
 * e2e/fullscreen-spike.test.ts: we do not ship on a spec claim for a
 * load-bearing corner; we measure it on all three engines.
 *
 * The claim under test: the injected `<base href="/api/raw/<dir>/">` (which
 * exists so the browser's own URL resolution — not a regex rewrite of
 * untrusted markup, ADR-0003 — turns `href="../assets/photo.png"` into the
 * `/api/raw/` route) might ALSO change how same-document fragment
 * references resolve. If `url(#grad)` resolved against the base instead of
 * the document, the slide would silently paint incomplete — violating
 * ADR-0001's promise that the SVG file is the artifact and renders
 * correctly.
 *
 * Method, per engine and per wrapper (view canvas / 總覽 thumbnail / 播放):
 * three srcdoc iframes built by the REAL wrapper functions —
 *
 *   - control: same slide, no `<base>` — the known-good local resolution;
 *   - withBase: the production output, `<base href="/api/raw/slides/">`;
 *   - broken: same slide with every `id` renamed so every fragment
 *     reference genuinely dangles — what "did not resolve" looks like.
 *
 * Judgement is by what is actually painted, never by errors: an unresolved
 * `url(#grad)` produces an unpainted shape, not an exception. Each of the
 * seven reference forms owns a 100×100 cell with fixed probe points, and
 * the probes' pixels (tiny screenshot clips of the same live page, byte-
 * compared) classify each form as matching the control, matching the
 * broken render, or neither. A sanity assertion first proves control and
 * broken really differ at each form — a probe that cannot tell resolved
 * from dangling would make "matches control" meaningless.
 *
 * The page is served over real http (not setContent): a srcdoc document's
 * fallback base URL is its parent's, and `<base href="/api/raw/…">` cannot
 * even resolve against about:blank — measuring there would silently turn
 * the base off and prove nothing. Any request that actually leaves for
 * `/api/raw/` is recorded too: a fragment resolved remotely shows up as a
 * fetch of the base URL, which is direct evidence of non-local resolution.
 */

// Every reference form the review named, one 100px cell each, all plain
// rects so the paint is deterministic and antialiasing-free at the probes.
// Hand-written fixture; colours are the expected values, chosen distinct.
const SLIDE_SVG = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="100" viewBox="0 0 700 100">`,
  `<style>.css-grad-target{fill:url(#cssgrad)}</style>`,
  `<defs>`,
  `<symbol id="sym" viewBox="0 0 100 100"><rect width="100" height="100" fill="#cc1111"/></symbol>`,
  `<linearGradient id="grad"><stop offset="0" stop-color="#2222aa"/><stop offset="1" stop-color="#2222aa"/></linearGradient>`,
  `<pattern id="pat" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#22aa22"/></pattern>`,
  `<clipPath id="clip"><rect x="300" y="0" width="50" height="100"/></clipPath>`,
  `<mask id="mask"><rect x="400" y="0" width="50" height="100" fill="#ffffff"/></mask>`,
  `<filter id="flood" x="0" y="0" width="1" height="1"><feFlood flood-color="#0066cc"/></filter>`,
  `<linearGradient id="cssgrad"><stop offset="0" stop-color="#aa22aa"/><stop offset="1" stop-color="#aa22aa"/></linearGradient>`,
  `</defs>`,
  `<use href="#sym" x="0" y="0" width="100" height="100"/>`,
  `<rect x="100" y="0" width="100" height="100" fill="url(#grad)"/>`,
  `<rect x="220" y="20" width="60" height="60" fill="none" stroke="url(#pat)" stroke-width="24"/>`,
  `<rect x="300" y="0" width="100" height="100" fill="#7722cc" clip-path="url(#clip)"/>`,
  `<rect x="400" y="0" width="100" height="100" fill="#aa8800" mask="url(#mask)"/>`,
  `<rect x="500" y="0" width="100" height="100" fill="#ff8800" filter="url(#flood)"/>`,
  `<rect x="600" y="0" width="100" height="100" class="css-grad-target"/>`,
  `</svg>`,
].join("");

// The broken twin: only the `id` attributes are renamed (the references are
// untouched), so every fragment reference dangles. A mechanical rename of
// the hand-written fixture above, not a second implementation of anything.
const BROKEN_SVG = SLIDE_SVG.replaceAll(`id="`, `id="missing-`);

// The exact base the production code injects for a slide at slides/001.svg.
const BASE_HREF = `/api/raw/${slideDirectory("slides/001.svg")}`;

/** Probe points inside a cell row (y is relative to the row's top edge). */
const FORMS: { name: string; probes: { x: number; y: number }[] }[] = [
  { name: `use href="#sym"`, probes: [{ x: 50, y: 50 }] },
  { name: `fill="url(#grad)"`, probes: [{ x: 150, y: 50 }] },
  { name: `stroke="url(#pat)"`, probes: [{ x: 220, y: 50 }] },
  // Inside and outside the clip: "clip ignored" and "element hidden" are
  // both failures but paint differently, and both differ from success.
  { name: `clip-path="url(#clip)"`, probes: [{ x: 325, y: 50 }, { x: 375, y: 50 }] },
  { name: `mask="url(#mask)"`, probes: [{ x: 425, y: 50 }, { x: 475, y: 50 }] },
  { name: `filter="url(#flood)"`, probes: [{ x: 550, y: 50 }] },
  { name: `CSS url(#cssgrad)`, probes: [{ x: 650, y: 50 }] },
];

const ROW_HEIGHT = 100;
const ROW_WIDTH = 700;
const PROBE_SIZE = 8;

interface Variant {
  name: string;
  sandbox: string;
  control: string;
  withBase: string;
  broken: string;
}

// The empty plan a slide with no 效果清單 gets — built from the real
// renderers, so the play document is the production shape end to end.
const EMPTY_PLAN = { steps: [], hidden: [] };
const PLAN_SCRIPT = renderPlanScript(EMPTY_PLAN);
const HIDE_STYLE = renderHideStyle(EMPTY_PLAN.hidden);

const VARIANTS: Variant[] = [
  {
    name: "檢視 canvas（wrapSlideDocument, sandbox=\"\"）",
    sandbox: "",
    control: wrapSlideDocument(SLIDE_SVG),
    withBase: wrapSlideDocument(SLIDE_SVG, BASE_HREF),
    broken: wrapSlideDocument(BROKEN_SVG),
  },
  {
    name: "總覽縮圖（overview 的 wrapSlideDocument, sandbox=\"\"）",
    sandbox: "",
    control: wrapThumbnailDocument(SLIDE_SVG),
    withBase: wrapThumbnailDocument(SLIDE_SVG, BASE_HREF),
    broken: wrapThumbnailDocument(BROKEN_SVG),
  },
  {
    // wrapPlayDocument has no no-base form (production play mode always
    // injects one), so this row's control/broken are the view wrapper under
    // the SAME sandbox tokens: the only pixel-relevant difference to the
    // withBase document is the <base> itself — the runtime with an empty
    // plan paints nothing.
    name: "播放（wrapPlayDocument, sandbox=\"allow-scripts\"）",
    sandbox: "allow-scripts",
    control: wrapSlideDocument(SLIDE_SVG),
    withBase: wrapPlayDocument(SLIDE_SVG, BASE_HREF, HIDE_STYLE, PLAN_SCRIPT),
    broken: wrapSlideDocument(BROKEN_SVG),
  },
];

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** One iframe row per (variant × document), stacked at known y offsets. */
function buildSpikePage(): { html: string; rowIndex: (variant: number, doc: number) => number } {
  const rows: string[] = [];
  for (const variant of VARIANTS) {
    for (const doc of [variant.control, variant.withBase, variant.broken]) {
      rows.push(
        `<iframe class="row" sandbox="${variant.sandbox}" srcdoc="${escapeAttribute(doc)}"></iframe>`,
      );
    }
  }
  const html = [
    `<!doctype html><html><head><meta charset="utf-8"><title>base 與片段參照實測</title>`,
    `<style>html,body{margin:0}iframe.row{display:block;border:0;margin:0;width:${ROW_WIDTH}px;height:${ROW_HEIGHT}px}</style>`,
    `</head><body>${rows.join("")}</body></html>`,
  ].join("");
  return { html, rowIndex: (variant, doc) => variant * 3 + doc };
}

type Engine = { name: string; type: BrowserType };
const ENGINES: Engine[] = [
  { name: "Chromium", type: chromium },
  { name: "Firefox", type: firefox },
  { name: "WebKit", type: webkit },
];

describe.each(ENGINES)("$name：srcdoc + <base> 之下的同文件片段參照", (engine) => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let rawRequests: string[];
  const { html: spikePage, rowIndex } = buildSpikePage();

  beforeAll(async () => {
    // A real http server: the srcdoc documents' fallback base URL is the
    // parent page's URL, and "/api/raw/…" must be resolvable against it for
    // the <base> to be live at all. Everything under /api/raw/ 404s, same
    // as the real server would for a fragment mis-resolved to a directory.
    server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(spikePage);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    browser = await engine.type.launch();
    console.log(`${engine.name} ${browser.version()}`);
    page = await browser.newPage({ viewport: { width: 800, height: 1000 } });

    rawRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/raw/")) rawRequests.push(request.url());
    });

    await page.goto(`http://127.0.0.1:${port}/`);
    // Every row must have parsed its SVG before any pixel is judged.
    // (expect.poll is not usable inside beforeAll, hence the hand poll —
    // it fails loudly on timeout rather than passing on a lucky sleep.)
    await pollUntil(async () => (await page.locator("iframe.row").count()) === VARIANTS.length * 3, "iframe 列數量");
    for (let i = 0; i < VARIANTS.length * 3; i++) {
      await pollUntil(
        async () => (await page.frameLocator(`iframe.row >> nth=${i}`).locator("svg").count()) === 1,
        `第 ${i} 列的 svg`,
      );
    }
    // One extra beat so paint (and any in-flight reference fetch) settles.
    await page.waitForTimeout(1000);
  });

  async function pollUntil(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`等不到：${what}`);
  }

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function probeShot(variant: number, doc: number, probe: { x: number; y: number }): Promise<Buffer> {
    const rowTop = rowIndex(variant, doc) * ROW_HEIGHT;
    return page.screenshot({
      clip: {
        x: probe.x - PROBE_SIZE / 2,
        y: rowTop + probe.y - PROBE_SIZE / 2,
        width: PROBE_SIZE,
        height: PROBE_SIZE,
      },
    });
  }

  it.each(VARIANTS.map((variant, index) => ({ variant, index })))(
    "$variant.name：<base> 不改變任何片段參照的繪製結果",
    async ({ index }) => {
      const matrix: string[] = [];
      const failures: string[] = [];

      for (const form of FORMS) {
        let matchesControl = true;
        let matchesBroken = true;
        let controlDiffersFromBroken = false;

        for (const probe of form.probes) {
          const control = await probeShot(index, 0, probe);
          const withBase = await probeShot(index, 1, probe);
          const broken = await probeShot(index, 2, probe);
          if (!control.equals(withBase)) matchesControl = false;
          if (!broken.equals(withBase)) matchesBroken = false;
          if (!control.equals(broken)) controlDiffersFromBroken = true;
        }

        // Sanity: a probe set that cannot tell a resolved reference from a
        // dangling one would make "matches control" vacuous.
        expect(controlDiffersFromBroken, `${form.name}：control 與 broken 在所有探測點都相同，探測點失去鑑別力`).toBe(true);

        const verdict = matchesControl
          ? "有 <base> 仍在本文件內解析（與 control 相同）"
          : matchesBroken
            ? "有 <base> 時參照失效（與 broken 相同）"
            : "有 <base> 時繪製結果異於 control 也異於 broken";
        matrix.push(`  ${form.name}: ${verdict}`);
        if (!matchesControl) failures.push(`${form.name}: ${verdict}`);
      }

      console.log(`${engine.name} / ${VARIANTS[index].name}\n${matrix.join("\n")}`);
      if (rawRequests.length > 0) {
        console.log(`  對 /api/raw/ 發出的請求：${JSON.stringify(rawRequests)}`);
      }

      // The regression this spike leaves behind: on this engine, in this
      // wrapper, the <base> changes nothing about fragment resolution.
      expect(failures, failures.join("; ")).toEqual([]);
    },
  );
});
