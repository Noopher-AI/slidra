import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  createFontBook,
  readBundledFontBytes,
  MEASURED_TEXT_CSS,
  type FontBook,
} from "@co-motion/core";

/**
 * 驗收條件 3：同一段文字在 Node 與瀏覽器量出的寬度一致。
 *
 * Node's number comes from `@co-motion/core`'s sfnt reader; the browser's
 * comes from a real Chromium laying out the very same font file. The two
 * are independent implementations — that is the whole point — so this file
 * only proves something if a wrong answer would actually make it red.
 * Three falsification controls do that job (see the bottom of the file):
 * the wrong font, the missing rendering CSS, and the wrong font size each
 * have to produce a number that visibly disagrees.
 *
 * Only Chromium, consistently with the rest of e2e/.
 */

const FAMILY = "Noto Sans TC";
const BROWSER_FAMILY = "CoMotion Bundled";
const SIZE = 100;

/**
 * Samples must mix Latin and CJK: a CJK-only string is exactly one em per
 * character in any full-width font, so it agrees with a wrong
 * implementation just as happily as with a right one.
 */
const SAMPLES = [
  "",
  "x",
  "Hello CoMotion",
  "AVWATo",
  "驗收用簡報",
  "第 3 頁 / 共 10 頁",
  "２０２６年Q3",
  "「引用」，。",
  "  a  b  ",
  "ｶﾞ",
  "「引用」，。（甲）：乙；",
];

// Samples containing CJK punctuation, which canvas measures differently —
// see the "canvas 沒有 text-spacing-trim" test below.
const CJK_PUNCTUATION_SAMPLES = new Set(["「引用」，。", "「引用」，。（甲）：乙；"]);

// getComputedTextLength() quantises to 1/64 px (0.015625). Largest deviation
// actually observed over the samples above on this machine, this Chromium:
// 0.0125 ("x": 49.8125 vs 49.8). 0.02 leaves room for the quantisation and
// nothing else.
const SVG_TOLERANCE = 0.02;
// canvas measureText returns a float; largest deviation observed over the
// same samples: 0.0001 ("Hello CoMotion": 720.9999 vs 721).
const CANVAS_TOLERANCE = 0.01;

const PAGE = [
  "<!doctype html><meta charset=\"utf-8\">",
  `<style>@font-face{font-family:"${BROWSER_FAMILY}";src:url(/font.ttf)}</style>`,
  '<svg id="stage" xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
].join("");

let server: Server;
let browser: Browser;
let page: Page;
let book: FontBook;

beforeAll(async () => {
  const ttf = await readBundledFontBytes();
  book = createFontBook([ttf]);

  server = createServer((req, res) => {
    if (req.url === "/font.ttf") {
      res.writeHead(200, { "content-type": "font/ttf" });
      res.end(ttf);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  // Without waiting for the face to load, every measurement below would be
  // taken against whatever fallback the OS supplies — the exact thing this
  // ticket exists to eliminate.
  await page.evaluate(
    (family) => document.fonts.load(`100px "${family}"`).then(() => document.fonts.ready),
    BROWSER_FAMILY,
  );
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function core(text: string, fontSize = SIZE): number {
  return book.measureText(text, { fontFamily: FAMILY, fontSize });
}

/** canvas measureText, with kerning switched off the only way canvas offers. */
function canvas(text: string, family = BROWSER_FAMILY, fontSize = SIZE): Promise<number> {
  return page.evaluate(
    ([t, f, s]) => {
      const ctx = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
      ctx.font = `${s as number}px "${f as string}"`;
      ctx.fontKerning = "none";
      return ctx.measureText(t as string).width;
    },
    [text, family, fontSize] as [string, string, number],
  );
}

/** A real <text> element in a real SVG — the actual rendering path. */
function svg(
  text: string,
  family = BROWSER_FAMILY,
  fontSize = SIZE,
  style = MEASURED_TEXT_CSS,
): Promise<number> {
  return page.evaluate(
    ([t, f, s, css]) => {
      const stage = document.getElementById("stage") as unknown as SVGSVGElement;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
      el.setAttribute("font-family", f as string);
      el.setAttribute("font-size", String(s as number));
      // Must be set in the XML namespace: `setAttribute("xml:space", ...)`
      // creates an inert attribute the browser ignores, and the leading and
      // repeated spaces then collapse (measured: 140.5 instead of 252.5).
      el.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      if (css) {
        el.setAttribute("style", css as string);
      }
      el.textContent = t as string;
      stage.appendChild(el);
      const width = el.getComputedTextLength();
      stage.removeChild(el);
      return width;
    },
    [text, family, fontSize, style] as [string, string, number, string],
  );
}

describe("Node 與瀏覽器對同一份字型量出同樣的寬度", () => {
  it.each(SAMPLES)("SVG <text> 與 core 一致：%j", async (text) => {
    const expected = core(text);
    const measured = await svg(text);
    expect(measured).toBeCloseTo(expected, 0);
    expect(Math.abs(measured - expected)).toBeLessThanOrEqual(SVG_TOLERANCE);
  });

  it.each(SAMPLES.filter((text) => !CJK_PUNCTUATION_SAMPLES.has(text)))(
    "canvas measureText 與 core 一致：%j",
    async (text) => {
      const expected = core(text);
      const measured = await canvas(text);
      expect(Math.abs(measured - expected)).toBeLessThanOrEqual(CANVAS_TOLERANCE);
    },
  );

  it("小數字級也一致（#70：字級會出現小數）", async () => {
    const expected = core("Hello CoMotion", 41.5);
    const measured = await canvas("Hello CoMotion", BROWSER_FAMILY, 41.5);
    expect(Math.abs(measured - expected)).toBeLessThanOrEqual(CANVAS_TOLERANCE);
  });
});

describe("證偽對照組——沒有這幾條，上面的斷言可能是恆真的", () => {
  it("A｜換一個字型，數字就對不上", async () => {
    const expected = core("Hello CoMotion");
    const wrongCanvas = await canvas("Hello CoMotion", "CoMotion Missing");
    const wrongSvg = await svg("Hello CoMotion", "CoMotion Missing");
    expect(Math.abs(wrongCanvas - expected)).toBeGreaterThan(1);
    expect(Math.abs(wrongSvg - expected)).toBeGreaterThan(1);
  });

  it("A'｜只有 CJK 的樣本連換字型都不會紅——所以樣本必須含 Latin", async () => {
    // Not a requirement, a warning kept executable: this is what a
    // tautological sample looks like.
    expect(await canvas("驗收用簡報", "CoMotion Missing")).toBe(core("驗收用簡報"));
  });

  it("B｜不套 MEASURED_TEXT_CSS，kerning 與 CJK 標點壓縮就回來了", async () => {
    const kerned = await svg("AVWATo", BROWSER_FAMILY, SIZE, "");
    expect(Math.abs(kerned - core("AVWATo"))).toBeGreaterThan(1);

    const trimmed = await svg("「引用」，。（甲）：乙；", BROWSER_FAMILY, SIZE, "");
    expect(Math.abs(trimmed - core("「引用」，。（甲）：乙；"))).toBeGreaterThan(1);
  });

  it("C｜量錯字級就對不上", async () => {
    const expected = core("Hello CoMotion", 41);
    const measured = await canvas("Hello CoMotion", BROWSER_FAMILY, 40);
    expect(Math.abs(measured - expected)).toBeGreaterThan(1);
  });

  it("canvas 沒有 text-spacing-trim，CJK 標點永遠對不上——量測必須走 <text>", async () => {
    // A measured limitation of the canvas API, pinned so that nobody
    // "fixes" the exclusion above by widening the tolerance.
    expect(await canvas("「引用」，。（甲）：乙；")).toBeCloseTo(1050, 3);
    expect(core("「引用」，。（甲）：乙；")).toBe(1200);
  });
});
