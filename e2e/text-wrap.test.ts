import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  createNewPresentation,
  openPresentation,
  readPresentationFileBytes,
  renderTextBoxContent,
  resolvePresentationFonts,
  wrapText,
  type FontMetrics,
  type TextRun,
  type WrappedText,
} from "@co-motion/core";

/**
 * 驗收條件 5：Node 與瀏覽器對同一份字型算出同樣的斷行結果 (AC5)，且斷行結果
 * 是烤進 SVG 檔案裡的（AC2/AC4），不是顯示時才算。
 *
 * Model: `e2e/text-metrics.test.ts`. Node measures through the same
 * `resolvePresentationFonts(id)` path a real command uses (#98); the
 * browser loads core's own **compiled** `packages/core/dist/text/wrap.js`
 * (and its `text-metrics.js` dependency) as static ES modules, with no
 * bundler, and builds a `FontMetrics` in-browser from the exact same font
 * bytes Node used (`readPresentationFileBytes`, not the download cache —
 * see text-metrics.test.ts's own comment on why that distinction matters).
 *
 * Falsification control (2nd describe block): the same samples at a
 * different width must produce different lines, or assertion 1 would be
 * vacuously true no matter what `wrapText` actually does.
 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDist = path.join(rootDir, "packages/core/dist");
const wrapJs = path.join(coreDist, "text/wrap.js");

const FAMILY = "Noto Sans TC";
const BROWSER_FAMILY = "CoMotion Bundled";

/** Mixed CJK + Latin, matching text-metrics.test.ts's own reasoning: a
 * CJK-only sample can't falsify a wrong implementation (every character is
 * a fixed em width in a full-width font). */
const SAMPLES: ReadonlyArray<[text: string, fontSize: number]> = [
  ["文字框有寬度，文字寫滿就折到下一行。", 40],
  ["「引用」，。文字框有寬度，文字寫滿就折到下一行，這是第三行測試用的內容。", 40],
  ["Hello CoMotion, this line is intentionally long enough to wrap", 32],
  ["", 40],
  ["驗", 40],
];

const WIDTH = 280;
const DIFFERENT_WIDTH = 420;

let server: Server;
let browser: Browser;
let page: Page;
let font: FontMetrics;
let fontBytes: Buffer;
let coMotionHome: string;
let comotDir: string;

const PAGE = [
  "<!doctype html><meta charset=\"utf-8\">",
  `<style>@font-face{font-family:"${BROWSER_FAMILY}";src:url(/font.ttf)}</style>`,
  '<svg id="stage" xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
].join("");

const JS_CONTENT_TYPES = new Set([".js", ".mjs"]);

beforeAll(async () => {
  await requireBuilt(wrapJs, "packages/core/dist 不存在，請先執行 npm run build");

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  const comotPath = path.join(comotDir, "deck.comot");
  await createNewPresentation(comotPath, "斷行驗收");
  const { id } = await openPresentation(comotPath);

  const fonts = await resolvePresentationFonts(id);
  const resolved = fonts.get(FAMILY);
  if (!resolved) {
    throw new Error(`簡報未內嵌字型：${FAMILY}`);
  }
  font = resolved;
  const ttf = await readPresentationFileBytes(id, "fonts/NotoSansTC-Presentation.ttf");
  fontBytes = ttf;

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/font.ttf") {
      res.writeHead(200, { "content-type": "font/ttf" });
      res.end(ttf);
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    // Everything else is a static file straight out of packages/core/dist —
    // the compiled module graph text/wrap.js pulls in (../errors.js,
    // ../text-metrics.js), with no bundler involved.
    const filePath = path.join(coreDist, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(coreDist)) {
      res.writeHead(403);
      res.end();
      return;
    }
    readFile(filePath)
      .then((content) => {
        const ext = path.extname(filePath);
        const contentType = JS_CONTENT_TYPES.has(ext) ? "text/javascript" : "application/octet-stream";
        res.writeHead(200, { "content-type": contentType });
        res.end(content);
      })
      .catch(() => {
        res.writeHead(404);
        res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await page.evaluate(
    (family) => document.fonts.load(`100px "${family}"`).then(() => document.fonts.ready),
    BROWSER_FAMILY,
  );
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

function nodeWrap(text: string, fontSizePx: number, width: number): WrappedText {
  return wrapText(text, { width, font, fontSizePx });
}

/**
 * Wraps the same text at the same width, in the browser, using core's own
 * compiled `text/wrap.js` and `text-metrics.js` — a real Chromium parses
 * the same font bytes Node used and calls the same `wrapText`.
 */
async function browserWrap(
  text: string,
  fontSizePx: number,
  width: number,
): Promise<{ lines: { text: string; y: number; width: number }[]; lineHeight: number; ascent: number }> {
  return page.evaluate(
    async ([t, size, w]) => {
      // A real dynamic `import(...)` in this file's source gets rewritten by
      // Vitest's own SSR transform to `__vite_ssr_dynamic_import__`, which
      // does not exist inside the browser page this callback is serialized
      // into (page.evaluate re-runs the function's source text verbatim in
      // Chromium, not in Node). Building the importer through `new
      // Function` keeps the literal `import(...)` out of this file's
      // static syntax, so Vitest's transform never sees it to rewrite.
      const dynamicImport = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<any>;
      const textMetrics = await dynamicImport("/text-metrics.js");
      const wrap = await dynamicImport("/text/wrap.js");
      const fontResponse = await fetch("/font.ttf");
      const bytes = new Uint8Array(await fontResponse.arrayBuffer());
      const parsedFont = textMetrics.parseFont(bytes);
      const wrapped = wrap.wrapText(t as string, {
        width: w as number,
        font: parsedFont,
        fontSizePx: size as number,
      });
      return {
        lines: wrapped.lines.map((line: { text: string; y: number; width: number }) => ({
          text: line.text,
          y: line.y,
          width: line.width,
        })),
        lineHeight: wrapped.lineHeight,
        ascent: wrapped.ascent,
      };
    },
    [text, fontSizePx, width] as [string, number, number],
  );
}

describe("Node 與瀏覽器對同一組樣本算出同樣的斷行結果 (AC5)", () => {
  it.each(SAMPLES)("%j @ fontSize %i", async (text, fontSize) => {
    const node = nodeWrap(text, fontSize, WIDTH);
    const browserResult = await browserWrap(text, fontSize, WIDTH);

    // Same compiled JS, same font bytes, same call — the two runs must
    // agree exactly, not merely "close enough" (#98's precision bar).
    expect(browserResult.lines.map((l) => l.text)).toEqual(node.lines.map((l) => l.text));
    node.lines.forEach((line, i) => {
      expect(browserResult.lines[i].y).toBe(line.y);
      expect(browserResult.lines[i].width).toBe(line.width);
    });
    expect(browserResult.lineHeight).toBe(node.lineHeight);
    expect(browserResult.ascent).toBe(node.ascent);
  });
});

describe("證偽對照組——沒有這一條，上面的斷言可能是恆真的", () => {
  it("同一組樣本換一個寬度，斷行結果就不一樣", async () => {
    const text = SAMPLES[0][0];
    const fontSize = SAMPLES[0][1];
    const atWidth = nodeWrap(text, fontSize, WIDTH);
    const atDifferentWidth = nodeWrap(text, fontSize, DIFFERENT_WIDTH);
    expect(atDifferentWidth.lines.map((l) => l.text)).not.toEqual(atWidth.lines.map((l) => l.text));

    const browserAtWidth = await browserWrap(text, fontSize, WIDTH);
    const browserAtDifferentWidth = await browserWrap(text, fontSize, DIFFERENT_WIDTH);
    expect(browserAtDifferentWidth.lines.map((l) => l.text)).not.toEqual(
      browserAtWidth.lines.map((l) => l.text),
    );
  });
});

describe("斷行結果本身是對的——每一行量出來都不超過宣告寬度", () => {
  // This is the one comparison in this file allowed a tolerance: it is not
  // rerunning our own JS twice (that's the AC5 block above, held to `toBe`)
  // but comparing our measurement against Chromium's own native text-shaping
  // engine rendering a real `<svg><text>` — the same class of comparison as
  // e2e/text-metrics.test.ts's A5 case, and the same 0.5%-of-width-scale
  // slack for hinting/rounding differences between the sfnt-table math here
  // and the browser's own layout engine.
  it("渲染成真正的 <svg> tspan，getComputedTextLength() 每行都 <= width * 1.005（除了單一超寬字元那一行）", async () => {
    const text = "文字框有寬度，文字寫滿就折到下一行。";
    const fontSize = 40;
    const node = nodeWrap(text, fontSize, WIDTH);

    const measured = await page.evaluate(
      ([lines, fam, size]) => {
        const stage = document.getElementById("stage") as unknown as SVGSVGElement;
        const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
        el.setAttribute("font-family", fam as string);
        el.setAttribute("font-size", String(size));
        el.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
        for (const line of lines as { text: string; y: number }[]) {
          const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
          tspan.setAttribute("x", "0");
          tspan.setAttribute("y", String(line.y));
          tspan.textContent = line.text;
          el.appendChild(tspan);
        }
        stage.appendChild(el);
        const lengths = Array.from(el.querySelectorAll("tspan")).map((t) => t.getComputedTextLength());
        stage.removeChild(el);
        return lengths;
      },
      [node.lines.map((l) => ({ text: l.text, y: l.y })), FAMILY, fontSize] as [
        { text: string; y: number }[],
        string,
        number,
      ],
    );

    measured.forEach((length) => {
      expect(length).toBeLessThanOrEqual(WIDTH * 1.005);
    });
  });
});

describe("純瀏覽器開檔——不經過 CoMotion server、不經過 runtime", () => {
  let tempDir: string;

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("file:// 直接開 SVG，斷行仍然正確：N 個 tspan、N 個遞增的 y、內容正確", async () => {
    const fontSize = 40;
    const text = "文字框有寬度，文字寫滿就折到下一行。";
    const wrapped = nodeWrap(text, fontSize, WIDTH);
    const content = renderTextBoxContent(wrapped.lines);

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n` +
      `  <g id="el-box" data-comot-text-width="${WIDTH}" transform="translate(100 200)">\n` +
      `    <text font-family="${FAMILY}" font-size="${fontSize}" xml:space="preserve"\n` +
      `    >${content}</text>\n` +
      `  </g>\n` +
      "</svg>\n";

    tempDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-plain-"));
    const filePath = path.join(tempDir, "slide.svg");
    await writeFile(filePath, svg, "utf-8");

    const plainPage = await browser.newPage();
    try {
      await plainPage.goto(`file://${filePath}`);
      const tspanInfo = await plainPage.evaluate(() =>
        Array.from(document.querySelectorAll("tspan")).map((t) => ({
          y: Number(t.getAttribute("y")),
          text: t.textContent,
        })),
      );

      expect(tspanInfo).toHaveLength(wrapped.lines.length);
      expect(tspanInfo.map((t) => t.text)).toEqual(wrapped.lines.map((l) => l.text));
      for (let i = 1; i < tspanInfo.length; i++) {
        expect(tspanInfo[i].y).toBeGreaterThan(tspanInfo[i - 1].y);
      }
    } finally {
      await plainPage.close();
    }
  });
});

/**
 * Writes `svg` to a fresh temp file and opens it in a brand-new page,
 * exactly the way `純瀏覽器開檔` above does — reused by every NOOP-65 case
 * below (A2/A4/A5/A6/A7) so each test only supplies its own `evaluate`
 * callback. Also doubles as each test's A8 proof: for content with no
 * `{{ }}` dynamic-text placeholder, `slide render`'s output is byte-identical
 * to the raw file (`renderSlideForDisplay`'s only transformation is
 * substituting those placeholders — `packages/cli/src/commands/slide-render.ts`),
 * so a plain `file://` open of this exact markup IS what `slide render`
 * would show.
 */
async function openSvgPage(svg: string, tempDirs: string[]): Promise<Page> {
  const dir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-noop65-"));
  tempDirs.push(dir);
  // The real embedded font, alongside the SVG, referenced by an in-SVG
  // `@font-face` (`boxSvg`/inline fixtures below all declare one pointing
  // at "font.ttf") — without a REAL bold/italic-capable face loaded, a
  // getComputedTextLength()/getComputedStyle() comparison between styled
  // and unstyled text would be comparing two renders of whatever generic
  // fallback font this sandbox happens to have, not proving anything about
  // this repo's own font-weight/font-style handling.
  await writeFile(path.join(dir, "font.ttf"), fontBytes);
  const filePath = path.join(dir, "slide.svg");
  await writeFile(filePath, svg, "utf-8");
  const svgPage = await browser.newPage();
  await svgPage.goto(`file://${filePath}`);
  await svgPage.evaluate(
    (family) => document.fonts.load(`100px "${family}"`).then(() => document.fonts.ready),
    FAMILY,
  );
  return svgPage;
}

describe("NOOP-65：硬換行／自動高度／粗體／斜體／列表各自有 e2e，瀏覽器排版與 slide render 輸出一致 (A2/A4/A5/A6/A7/A8)", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function boxSvg(elementId: string, innerText: string, width: number, height: number, extraContainerAttrs = ""): string {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n` +
      `  <style>@font-face{font-family:"${FAMILY}";src:url("font.ttf")}</style>\n` +
      `  <g id="${elementId}" data-comot-text-width="${width}" data-comot-text-height="${height}"${extraContainerAttrs}>\n` +
      `    <text font-family="${FAMILY}" font-size="40" xml:space="preserve">${innerText}</text>\n` +
      `  </g>\n` +
      "</svg>\n"
    );
  }

  it("A2：硬換行——data-comot-break 標記的行與下一行的內容各自獨立、逐行量得出正確寬度", async () => {
    const text = "第一段\n第二段";
    const wrapped = nodeWrap(text, 40, WIDTH);
    expect(wrapped.lines).toHaveLength(2);
    expect(wrapped.lines[0].hardBreak).toBe(true);
    const content = renderTextBoxContent(wrapped.lines);
    expect(content).toContain('data-comot-break="1"');

    const svg = boxSvg("el-a2", content, WIDTH, wrapped.height);
    const svgPage = await openSvgPage(svg, tempDirs);
    try {
      const measured = await svgPage.evaluate(() => {
        const tspans = Array.from(document.querySelectorAll("tspan"));
        return tspans.map((t) => ({
          text: t.textContent,
          hasBreak: t.hasAttribute("data-comot-break"),
          length: (t as unknown as SVGTextContentElement).getComputedTextLength(),
        }));
      });
      expect(measured).toHaveLength(2);
      expect(measured[0]).toMatchObject({ text: "第一段", hasBreak: true });
      expect(measured[1]).toMatchObject({ text: "第二段", hasBreak: false });
      measured.forEach((line) => expect(line.length).toBeGreaterThan(0));
    } finally {
      await svgPage.close();
    }
  });

  it("A4：自動高度——文字從 1 段變 3 段後，data-comot-text-height 與瀏覽器實際量到的 bbox 高度都跟著等比例變高", async () => {
    const oneLine = nodeWrap("一行", 40, WIDTH);
    const threeLines = nodeWrap("一行\n二行\n三行", 40, WIDTH);
    // Ground truth for "grew 3x", independent of the browser: core's own
    // declared height for 3 lines is (within float rounding) exactly 3x
    // its declared height for 1 line.
    expect(threeLines.height).toBeCloseTo(3 * oneLine.height, 4);

    const svg1 = boxSvg("el-a4-1", renderTextBoxContent(oneLine.lines), WIDTH, oneLine.height);
    const svg3 = boxSvg("el-a4-3", renderTextBoxContent(threeLines.lines), WIDTH, threeLines.height);
    const page1 = await openSvgPage(svg1, tempDirs);
    const page3 = await openSvgPage(svg3, tempDirs);
    try {
      const measureBBoxHeight = (p: Page) =>
        p.evaluate(() => (document.querySelector("text") as unknown as SVGGraphicsElement).getBBox().height);
      const h1 = await measureBBoxHeight(page1);
      const h3 = await measureBBoxHeight(page3);
      expect(h1).toBeGreaterThan(0);
      // getBBox() is the tight glyph box (ascent-to-descender of the actual
      // rendered glyphs), not the hhea line-height box core's declared
      // height uses — the two are never pixel-identical, so this asserts
      // the SAME 3x growth the declared height has, with slack for that
      // difference, rather than a false pixel-exact equivalence.
      expect(h3 / h1).toBeGreaterThan(2.5);
      expect(h3 / h1).toBeLessThan(3.5);
    } finally {
      await page1.close();
      await page3.close();
    }
  });

  it("A5：粗體——巢狀 tspan 帶 font-weight=\"bold\"，瀏覽器實際套用（getComputedStyle 為 bold，不只是寫了屬性）", async () => {
    const text = "abc粗體def";
    const runs: TextRun[] = [{ start: 3, end: 5, fontWeight: "bold" }];
    const wrapped = nodeWrap(text, 40, WIDTH * 2); // wide enough for 1 line
    const content = renderTextBoxContent(wrapped.lines, runs);
    expect(content).toContain('<tspan font-weight="bold">粗體</tspan>');

    const svg = boxSvg("el-a5", content, WIDTH * 2, wrapped.height);
    const svgPage = await openSvgPage(svg, tempDirs);
    try {
      const measured = await svgPage.evaluate(() => {
        const t = document.querySelector('tspan[font-weight="bold"]')!;
        const style = getComputedStyle(t);
        return { fontWeight: style.fontWeight, text: t.textContent };
      });
      expect(measured.text).toBe("粗體");
      // "700" is what getComputedStyle normalizes the "bold" keyword to
      // (CSS Fonts §fontWeightMapping) — this font has no distinct bold
      // face to swap in (a single-weight static TTF), so Chromium's own
      // faux-bold synthesis is what actually renders; getComputedTextLength()
      // cannot detect that (synthetic bold thickens strokes without
      // changing advance widths), which is why this asserts the resolved
      // style instead.
      expect(["bold", "700"]).toContain(measured.fontWeight);
    } finally {
      await svgPage.close();
    }
  });

  it("A6：斜體——巢狀 tspan 帶 font-style=\"italic\"，getComputedStyle(tspan).fontStyle 為 italic", async () => {
    const text = "abc斜體def";
    const runs: TextRun[] = [{ start: 3, end: 5, fontStyle: "italic" }];
    const wrapped = nodeWrap(text, 40, WIDTH * 2);
    const content = renderTextBoxContent(wrapped.lines, runs);
    expect(content).toContain('<tspan font-style="italic">斜體</tspan>');

    const svg = boxSvg("el-a6", content, WIDTH * 2, wrapped.height);
    const svgPage = await openSvgPage(svg, tempDirs);
    try {
      const fontStyle = await svgPage.evaluate(() => {
        const t = document.querySelector('tspan[font-style="italic"]')!;
        return getComputedStyle(t).fontStyle;
      });
      expect(fontStyle).toBe("italic");
    } finally {
      await svgPage.close();
    }
  });

  it("A7：列表——marker <text> 的符號與內容 <text> 的縮排都渲染正確（bullet 與 number）", async () => {
    const text = "第一項\n第二項";
    const indent = 1.5 * 40; // LIST_INDENT_EM * fontSize
    const wrapped = wrapText(text, { width: WIDTH, font, fontSizePx: 40, indents: [indent, indent] });
    const content = renderTextBoxContent(wrapped.lines);
    const markerMarkup =
      `<text data-comot-list-marker="true" font-family="${FAMILY}" font-size="40" xml:space="preserve">` +
      `<tspan x="0" y="${wrapped.lines[0].y}">•</tspan>` +
      `<tspan x="0" y="${wrapped.lines[1].y}">1.</tspan>` +
      "</text>";
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n` +
      `  <g id="el-a7" data-comot-text-width="${WIDTH}" data-comot-text-height="${wrapped.height}" data-comot-list="bullet number">\n` +
      `    <text font-family="${FAMILY}" font-size="40" xml:space="preserve">${content}</text>${markerMarkup}\n` +
      `  </g>\n` +
      "</svg>\n";

    const svgPage = await openSvgPage(svg, tempDirs);
    try {
      const measured = await svgPage.evaluate(() => {
        const texts = Array.from(document.querySelectorAll("text"));
        const contentText = texts[0];
        const markerText = texts[1];
        return {
          contentTspanXs: Array.from(contentText.querySelectorAll("tspan")).map((t) => t.getAttribute("x")),
          markerGlyphs: Array.from(markerText.querySelectorAll("tspan")).map((t) => t.textContent),
          markerIsMarked: markerText.hasAttribute("data-comot-list-marker"),
        };
      });
      expect(measured.markerIsMarked).toBe(true);
      expect(measured.markerGlyphs).toEqual(["•", "1."]);
      measured.contentTspanXs.forEach((x) => expect(Number(x)).toBeCloseTo(indent, 4));
    } finally {
      await svgPage.close();
    }
  });
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
