import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";

/**
 * NOOP-144/NOOP-177 (Plan: NOOP-174) — in-place text editing acceptance
 * tests. Modelled on e2e/direct-manipulation.test.ts's startServerFor/
 * openApp shape and its font-staging trick (the fixture's project.json
 * declares "Noto Sans TC" but ships no font bytes; this file copies the
 * real ones from assets/fonts into a throwaway staging
 * dir before packing, same as that file does).
 *
 * Entry point exercised: `beginTextEdit` via the runtime's own
 * dblclick-on-a-text-box path (`data-slidra-text-width` on the container) —
 * per NOOP-174's plan, wiring `beginTextEdit` to the INSERT flow is out of
 * scope for this ticket (T2/NOOP-159); this file's dblclick IS the public
 * entry point NOOP-174 designates as the equivalent path for AC1.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/text-edit-deck");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };
const VIEWBOX = { width: 1280, height: 720 };
const baselineDir = path.join(e2eDir, "__screenshots__/text-edit");
const FONT_SIZE = 24;

let browser: Browser;
let openPages: Page[] = [];
let fontDataUrl: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  const fontBytes = await readFile(path.join(presentationFontDir, "NotoSansTC-Presentation.ttf"));
  fontDataUrl = `data:font/ttf;base64,${fontBytes.toString("base64")}`;
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-text-edit-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-text-edit-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-text-edit-deck-"));
  process.env.SLIDRA_HOME = slidraHome;
  // [E4.T9]/F7: slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  await cp(deckDir, deckStagingDir, { recursive: true });
  await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
  await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckStagingDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "此測試不會送出訊息",
    },
  };

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
      await rm(deckStagingDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return page;
}

async function readSlide(registry: CommandRegistry, presentationId: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

/** `<g id="elementId" ... data-slidra-text-width="N">`'s declared wrap width. */
function readDeclaredTextWidth(svg: string, elementId: string): number {
  const match = new RegExp(`<g id="${elementId}"[^>]*data-slidra-text-width="([^"]+)"`).exec(svg);
  if (!match) throw new Error(`找不到 ${elementId} 的 data-slidra-text-width`);
  return Number(match[1]);
}

/**
 * Chromium's own `getComputedTextLength()` for `text` at `fontSizePx` in the
 * real embedded presentation font — same technique as
 * text-metrics.test.ts's `renderedWidthInChromium`, the external ground
 * truth this file's wrap assertions compare against post-[E4.T12] (the
 * TypeScript engine's own `wrapText`, previously used as the oracle here,
 * no longer exists).
 */
async function renderedWidthInChromium(page: Page, text: string, fontSizePx: number): Promise<number> {
  return page.evaluate(
    async ([url, family, sampleText, size]) => {
      const style = document.createElement("style");
      style.textContent = `@font-face{font-family:"${family}";src:url("${url}") format("truetype");}`;
      document.head.appendChild(style);

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("font-family", family);
      textEl.setAttribute("font-size", String(size));
      textEl.textContent = sampleText;
      svg.appendChild(textEl);
      document.body.appendChild(svg);

      await document.fonts.load(`${size}px "${family}"`);
      await document.fonts.ready;

      const length = textEl.getComputedTextLength();
      svg.remove();
      style.remove();
      return length;
    },
    [fontDataUrl, "Noto Sans TC", text, fontSizePx] as const,
  );
}

/** Whether the runtime's hidden edit textarea currently has document focus inside the sandboxed slide iframe — the signal that `begin-text-edit`'s async round trip (font fetch included) has actually landed. */
async function isEditTextareaFocused(page: Page): Promise<boolean> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate(() => {
    const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement | null;
    const active = host?.shadowRoot?.activeElement;
    return !!active && active.tagName === "TEXTAREA";
  });
}

/**
 * Double-clicks the right half of `elementId`'s last character. Entering
 * edit by dblclick puts the caret at the click point (05-INTERACTIONS
 * 「就地編輯」), so this is how a test opens an edit session with the caret
 * at the END of the text — dblclicking the element's centre would land it
 * mid-string.
 */
async function dblclickAtEnd(page: Page, elementId: string): Promise<void> {
  const frame = page.frameLocator("iframe.slide-frame");
  const p = await frame.locator("body").evaluate((body, elementId) => {
    const doc = body.ownerDocument as Document;
    const el = doc.getElementById(elementId)!;
    const textEl = (el.tagName === "text" ? el : el.querySelector("text")) as SVGTextContentElement;
    const ctm = textEl.getScreenCTM()!;
    const last = textEl.getNumberOfChars() - 1;
    const toClient = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(ctm);
    const ext = textEl.getExtentOfChar(last);
    const start = toClient(textEl.getStartPositionOfChar(last).x, 0);
    const end = toClient(textEl.getEndPositionOfChar(last).x, 0);
    const mid = toClient(ext.x + ext.width / 2, ext.y + ext.height / 2);
    return { x: start.x + (end.x - start.x) * 0.75, y: mid.y };
  }, elementId);
  const box = await page.locator("iframe.slide-frame").boundingBox();
  if (!box) throw new Error("量不到 iframe.slide-frame 的邊界框");
  await page.mouse.dblclick(box.x + p.x, box.y + p.y);
}

async function waitForEditTextareaFocus(page: Page): Promise<void> {
  await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);
}

/**
 * ADR-0017 (NOOP-272/T6) — caret/selection geometry helpers below. Every
 * one of these reads its numbers straight off the browser's own SVG text
 * geometry APIs (`getStartPositionOfChar`/`getEndPositionOfChar`/
 * `getScreenCTM`, `<tspan>.getBoundingClientRect()`) — never off the
 * runtime's own `indexAtPoint()`/`textLineRanges()` — so a test using them
 * is an independent check on the runtime's behaviour, not a tautology
 * that would pass even if that behaviour were wrong. This is the same
 * technique the plan's own spike (§3.4) validated against Chromium.
 */

/** Ground-truth client-space geometry for character `index` of `elementId`'s `<text>`. */
async function charClientRect(
  page: Page,
  elementId: string,
  index: number,
): Promise<{ startX: number; endX: number; top: number; height: number }> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate(
    (body, { elementId, index }) => {
      const doc = body.ownerDocument as Document;
      const el = doc.getElementById(elementId)!;
      const textEl = el.querySelector("text") as SVGTextContentElement;
      const ctm = textEl.getScreenCTM()!;
      const toClient = (p: { x: number; y: number }) => new DOMPoint(p.x, p.y).matrixTransform(ctm);
      const start = toClient(textEl.getStartPositionOfChar(index));
      const end = toClient(textEl.getEndPositionOfChar(index));
      const tspans = textEl.getElementsByTagName("tspan");
      let top = 0;
      let height = 0;
      if (tspans.length === 0) {
        const r = textEl.getBoundingClientRect();
        top = r.top;
        height = r.height;
      } else {
        let cursor = 0;
        for (let i = 0; i < tspans.length; i++) {
          const len = tspans[i].textContent!.length;
          if (index < cursor + len || i === tspans.length - 1) {
            const r = tspans[i].getBoundingClientRect();
            top = r.top;
            height = r.height;
            break;
          }
          cursor += len;
        }
      }
      return { startX: start.x, endX: end.x, top, height };
    },
    { elementId, index },
  );
}

/**
 * `charClientRect`/`getBoundingClientRect` are relative to the sandboxed
 * iframe's OWN viewport, not the top-level page — the same reason the
 * existing drag test above computes its click point off `svg.boundingBox()`
 * rather than raw numbers. This is the offset to add before any
 * `page.mouse.*` call driven by an iframe-local rect.
 */
async function iframeOffset(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator("iframe.slide-frame").boundingBox();
  if (!box) throw new Error("量不到 iframe.slide-frame 的邊界框");
  return { x: box.x, y: box.y };
}

/** Clicks the point 1/4 of the way across character `index` — inside the half `indexAtPoint`'s midpoint rule (ADR-0017 §4.2) resolves to that same index, away from the exact midpoint boundary. */
async function clickChar(page: Page, elementId: string, index: number): Promise<void> {
  const rect = await charClientRect(page, elementId, index);
  const offset = await iframeOffset(page);
  const x = offset.x + rect.startX + (rect.endX - rect.startX) * 0.25;
  const y = offset.y + rect.top + rect.height / 2;
  await page.mouse.click(x, y);
}

/** Drags a text selection from the start of character `fromIndex` to the start of character `toIndex` (page-offset-corrected — see `iframeOffset`). */
async function dragSelectChars(page: Page, elementId: string, fromIndex: number, toIndex: number, steps = 5): Promise<void> {
  const offset = await iframeOffset(page);
  const from = await charClientRect(page, elementId, fromIndex);
  const to = await charClientRect(page, elementId, toIndex);
  await page.mouse.move(offset.x + from.startX, offset.y + from.top + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(offset.x + to.startX, offset.y + to.top + to.height / 2, { steps });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(80);
}

/** `textarea.selectionStart`/`selectionEnd` of the runtime's hidden edit textarea. */
async function readSelection(page: Page): Promise<{ start: number; end: number }> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate((body) => {
    const doc = body.ownerDocument as Document;
    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const ta = host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
    return { start: ta.selectionStart as number, end: ta.selectionEnd as number };
  });
}

/** The `.edit-frame` overlay div's own `display` value ("block" while editing, "none" otherwise). */
async function readEditFrameDisplay(page: Page): Promise<string> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate((body) => {
    const doc = body.ownerDocument as Document;
    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    return (host.shadowRoot!.querySelector(".edit-frame") as HTMLElement).style.display;
  });
}

/** The `.edit-caret` overlay div's own client rect, or `null` when hidden. */
async function readCaretRect(page: Page): Promise<{ left: number; top: number; height: number } | null> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate((body) => {
    const doc = body.ownerDocument as Document;
    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const caret = host.shadowRoot!.querySelector(".edit-caret") as HTMLElement;
    if (getComputedStyle(caret).display === "none") return null;
    const r = caret.getBoundingClientRect();
    return { left: r.left, top: r.top, height: r.height };
  });
}

/** Visible `.edit-selection` overlay divs' client rects, DOM order. */
async function readSelectionBlockRects(
  page: Page,
): Promise<{ left: number; top: number; right: number; bottom: number }[]> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate((body) => {
    const doc = body.ownerDocument as Document;
    const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
    const blocks = [...host.shadowRoot!.querySelectorAll(".edit-selection")] as HTMLElement[];
    return blocks
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
  });
}

/** Number of `<tspan>` children currently under `elementId`'s live (in-edit-preview) `<text>`. */
async function tspanCount(page: Page, elementId: string): Promise<number> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate((body, elementId) => {
    const doc = body.ownerDocument as Document;
    const el = doc.getElementById(elementId)!;
    return el.querySelector("text")!.getElementsByTagName("tspan").length;
  }, elementId);
}

/** `<tspan x="0" y="…">…</tspan>` entries inside `elementId`'s own `<text>`, in document order. */
function readTspans(svg: string, elementId: string): { text: string; y: number }[] {
  const containerMatch = new RegExp(`<g id="${elementId}"[^>]*>\\s*<text[^>]*>([\\s\\S]*?)</text>`).exec(svg);
  if (!containerMatch) throw new Error(`找不到 ${elementId} 的 <text>`);
  // `data-slidra-break="1"` (NOOP-65 決定 A) is an optional trailing attribute
  // on a line that ends on a hard break — matched but not captured, so this
  // helper's existing callers (none of which touch hard breaks) see no
  // change in behaviour.
  const tspanRe = /<tspan x="0" y="([-\d.]+)"(?: data-slidra-break="1")?>([^<]*)<\/tspan>/g;
  const out: { text: string; y: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = tspanRe.exec(containerMatch[1])) !== null) {
    out.push({ y: Number(match[1]), text: match[2] });
  }
  return out;
}

/** The `<g id="elementId">`'s own `transform` attribute, or `""` when absent — same shape as direct-manipulation.test.ts's own helper. */
function readTransformAttr(svg: string, elementId: string): string {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  return elementMatch ? elementMatch[1] : "";
}

it("雙擊文字框進入編輯、打字、Esc 離開：SVG 的 tspan 逐行內容不丟字、每行實際渲染寬度都在宣告寬度內，整段編輯只送一條命令，undo 一格回到原字串（AC1/AC2）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    let commandCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/command")) commandCount++;
    });

    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    // The editing model has no caret/selection (only append/backspace at
    // the string's end, §7 決定 6) — the textarea starts pre-loaded with
    // the fixture's own initial text ("Hi"), so typing appends after it
    // rather than replacing it. `finalText` below is what actually ends
    // up committed.
    const typed = "Hello Slidra 文字框就地編輯測試內容一二三四五六七八九十";
    const finalText = "Hi" + typed;
    await page.keyboard.type(typed);
    // Let the rAF/postMessage round trip for the live preview settle before
    // leaving — mirrors direct-manipulation.test.ts's own drag-settle wait.
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
    // POST /api/command round trip + the file write it causes.
    await page.waitForTimeout(200);

    expect(commandCount).toBe(1);

    const after = await readSlide(registry, presentationId);
    const actualLines = readTspans(after, "el-text");

    // Non-circular wrap assertions (post-[E4.T12]: the TypeScript engine's
    // `wrapText`, previously this test's oracle, no longer exists — Rust
    // comparing against Rust would be circular). (a) the fixture's whole
    // point: this text must actually wrap; (b) no content is lost or
    // reordered across the line breaks; (c) every line actually fits its
    // declared width in a real browser (Chromium's `getComputedTextLength()`,
    // the same external ground truth text-metrics.test.ts uses) — an
    // external check stronger than the old same-engine comparison.
    expect(actualLines.length).toBeGreaterThan(1);
    expect(actualLines.map((line) => line.text).join("").replace(/\s+/g, "")).toBe(
      finalText.replace(/\s+/g, ""),
    );
    const declaredWidth = readDeclaredTextWidth(after, "el-text");
    for (const line of actualLines) {
      if (line.text === "") continue; // A trailing empty wrapped line has nothing to measure.
      const renderedWidth = await renderedWidthInChromium(page, line.text, FONT_SIZE);
      expect(renderedWidth, `行 "${line.text}" 的實際渲染寬度`).toBeLessThanOrEqual(declaredWidth * 1.005);
    }

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("進入編輯後不打字直接 Esc：不送任何命令（AC5）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    let commandCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/command")) commandCount++;
    });

    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    expect(commandCount).toBe(0);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("編輯期間在被編輯元素上按下並拖曳：transform 不變、不送命令、沒有多選框（AC3）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    let commandCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/command")) commandCount++;
    });

    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    const svg = page.frameLocator("iframe.slide-frame").locator("svg").first();
    const svgBoxRect = await svg.boundingBox();
    if (!svgBoxRect) throw new Error("量不到主畫布 svg 的邊界框");
    // el-text: translate(100 100), width 220, font-size 24 -> roughly
    // 100..320 x, 100..~130 y. A point comfortably inside that box.
    const start = {
      x: svgBoxRect.x + (150 / VIEWBOX.width) * svgBoxRect.width,
      y: svgBoxRect.y + (115 / VIEWBOX.height) * svgBoxRect.height,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y, { steps: 5 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(150);

    // Still editing (the drag attempt neither committed nor started a
    // gesture) — confirm by committing now via Esc, expecting the still-0
    // command count to remain 0 (no text was typed either).
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    expect(commandCount).toBe(0);
    const after = await readSlide(registry, presentationId);
    expect(readTransformAttr(after, "el-text")).toBe("translate(100 100)");
    expect(after).toBe(before);

    const multiBoxVisible = await page.evaluate(() => {
      const host = document.querySelector("iframe.slide-frame") as HTMLIFrameElement | null;
      const doc = host?.contentDocument;
      const selHost = doc?.querySelector("[data-slidra-selection-host]") as HTMLElement | null;
      const boxes = selHost?.shadowRoot?.querySelectorAll(".sel-multi") ?? [];
      return Array.from(boxes).some((el) => getComputedStyle(el as HTMLElement).display !== "none");
    });
    expect(multiBoxVisible).toBe(false);
  } finally {
    await cleanup();
  }
});

it("鎖定的文字框雙擊不會進入編輯：沒有 focus 到編輯用 textarea，打字後檔案不變（AC4）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    await page.frameLocator("iframe.slide-frame").locator("#el-locked-text").dblclick();
    await page.waitForTimeout(300);

    expect(await isEditTextareaFocused(page)).toBe(false);

    await page.keyboard.type("這不應該寫進檔案");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("A1：ArrowLeft 依序左移游標，caret 畫面位置與 textarea.selectionStart 同步", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    expect(await readEditFrameDisplay(page)).not.toBe("block"); // Nothing being edited yet.
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);
    expect(await readEditFrameDisplay(page)).toBe("block"); // Editing frame is now shown.
    // Fixture's initial text is "Hi" (len 2) — type more so there is enough
    // room to walk the caret left several steps.
    await page.keyboard.type("ABCD");
    await page.waitForTimeout(80);
    const len = "HiABCD".length;

    for (let n = 1; n <= len; n++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(30);
      const sel = await readSelection(page);
      expect(sel.start).toBe(len - n);
      expect(sel.end).toBe(len - n);
      const caret = await readCaretRect(page);
      expect(caret).not.toBeNull();
      const expected = await charClientRect(page, "el-text", len - n);
      expect(caret!.left).toBeCloseTo(expected.startX, 0);
    }
  } finally {
    await cleanup();
  }
});

// A16（NOOP-65r3 §4 C2）：preview 通道 off-by-one 的原始重現情境——有硬換行
//時，點第 2 行第 1 個字，游標必須落在點到的字，不是差一個字元。第 1、2 輪
// FAIL 1 的根因是 canvas.ts 的 preview 從不帶 data-slidra-break，讓
// selection-runtime.js 的 textLineRanges（本身是對的）在編輯階段永遠拿不到
// 硬換行標記，於是編輯期間的行邊界算錯。這是 A2 座標版本（clickChar →
// selectionStart → 打字 → value）的嚴格超集，同一輸入路徑在更難的情境（跨
// 硬換行）下做同一組斷言，所以取代 A2（單行、無硬換行的逐字元零偏移仍有
// A1/A6 守著）。
it("A16：有硬換行時，點第 2 行第 1 個字，游標落在點到的字（preview 通道 off-by-one 的機械重現，AC2 的硬換行版本）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await page.waitForTimeout(150);
    // DOM string is "HiAAA"+"BBB" (8 DOM chars); value string is
    // "HiAAA\nBBB" (9 chars) — the hard break counts as one value char but
    // zero DOM chars. clickChar's index is DOM-space (fed straight to
    // getStartPositionOfChar), so DOM index 5 ("B", the second line's
    // first char) must map to value index 6 (§3.9 決定 A16 的索引換算).
    await clickChar(page, "el-text", 5);
    await page.waitForTimeout(80);
    expect((await readSelection(page)).start).toBe(6);

    await page.keyboard.type("X");
    await page.waitForTimeout(80);
    expect(await isEditTextareaFocused(page)).toBe(true);
    const value = await page.frameLocator("iframe.slide-frame").locator("body").evaluate((body) => {
      const doc = body.ownerDocument as Document;
      const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
      return (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value;
    });
    expect(value).toBe("HiAAA\nXBBB"); // caret sits before value index 6 ("B") — "HiAAA\n" | "X" | "BBB"
  } finally {
    await cleanup();
  }
});

// A17：A16 的另一側——硬換行那一行的「行尾」。點該行最後一個字的右半邊，
// 游標要停在 "\n" 之前（該行結尾），不是 "\n" 之後（下一行開頭）；caret 也
// 要畫在該行最後一個字的右側，不是下一行、也不是該行最左邊。
it("A17：有硬換行時，點第 1 行最後一個字的右半邊，游標停在該行結尾（\\n 之前），caret 畫在該字右側", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await page.waitForTimeout(150);
    // DOM "HiAAA"+"BBB"; value "HiAAA\nBBB". DOM index 4 is line 1's last
    // char; its right half must resolve to value index 5 (before "\n"),
    // not 6 (line 2's start).
    const last = await charClientRect(page, "el-text", 4);
    const offset = await iframeOffset(page);
    await page.mouse.click(offset.x + last.startX + (last.endX - last.startX) * 0.75, offset.y + last.top + last.height / 2);
    await page.waitForTimeout(80);
    expect((await readSelection(page)).start).toBe(5);

    const caret = await readCaretRect(page);
    expect(caret).not.toBeNull();
    expect(Math.abs(caret!.left - last.endX)).toBeLessThan(3);
    expect(Math.abs(caret!.top - last.top)).toBeLessThan(3);

    await page.keyboard.type("X");
    await page.waitForTimeout(80);
    const value = await page.frameLocator("iframe.slide-frame").locator("body").evaluate((body) => {
      const doc = body.ownerDocument as Document;
      const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
      return (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value;
    });
    expect(value).toBe("HiAAAX\nBBB");
  } finally {
    await cleanup();
  }
});

// A18：跨硬換行拖曳選取——"\n" 前那一行的反白區塊必須從起點畫到該行最後一個
// 字的右側，不能因為範圍含虛擬的 "\n" 而量到下一行第 1 個字的位置。
it("A18：跨硬換行拖曳選取，第 1 行的反白區塊從起點畫到該行行尾", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await page.waitForTimeout(150);

    // DOM 2 ("A", line 1) → DOM 6 ("B", line 2's 2nd char): value 2..7.
    await dragSelectChars(page, "el-text", 2, 6);
    const sel = await readSelection(page);
    expect(sel.start).toBe(2);
    expect(sel.end).toBe(7);

    const c2 = await charClientRect(page, "el-text", 2);
    const c4 = await charClientRect(page, "el-text", 4);
    const c5 = await charClientRect(page, "el-text", 5);
    const blocks = await readSelectionBlockRects(page);
    expect(blocks.length).toBe(2);
    expect(Math.abs(blocks[0].left - c2.startX)).toBeLessThan(3);
    expect(Math.abs(blocks[0].right - c4.endX)).toBeLessThan(3);
    expect(Math.abs(blocks[1].left - c5.startX)).toBeLessThan(3);
    expect(Math.abs(blocks[1].right - c5.endX)).toBeLessThan(3);
  } finally {
    await cleanup();
  }
});

// A19：雙擊進入編輯時，游標落在雙擊處，不是文字結尾（05-INTERACTIONS
// 「就地編輯」）。先用一次編輯建立兩行內容並提交，再雙擊第 2 行第 2 個字。
it("A19：雙擊多行文字框的第 2 行某字，進入編輯後游標落在該字，不是結尾", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);
    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    expect(readTspans(await readSlide(registry, presentationId), "el-text").map((l) => l.text)).toEqual(["HiAAA", "BBB"]);

    // Committed DOM "HiAAA"+"BBB"; value "HiAAA\nBBB". DOM index 6 (line 2's
    // 2nd "B") must open editing with the caret at value index 7.
    const target = await charClientRect(page, "el-text", 6);
    const offset = await iframeOffset(page);
    await page.mouse.dblclick(offset.x + target.startX + (target.endX - target.startX) * 0.25, offset.y + target.top + target.height / 2);
    await waitForEditTextareaFocus(page);
    await page.waitForTimeout(150);
    expect((await readSelection(page)).start).toBe(7);

    await page.keyboard.type("X");
    await page.waitForTimeout(80);
    const value = await page.frameLocator("iframe.slide-frame").locator("body").evaluate((body) => {
      const doc = body.ownerDocument as Document;
      const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
      return (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value;
    });
    expect(value).toBe("HiAAA\nBXBB");
  } finally {
    await cleanup();
  }
});

it("A3：拖曳選取 3 個字後打一個字，該 3 字被取代為 1 字", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);
    await page.keyboard.type("ABCDE"); // -> "HiABCDE" (len 7)
    await page.waitForTimeout(80);

    await dragSelectChars(page, "el-text", 2, 5); // selects "ABC" (indices 2..4)

    const sel = await readSelection(page);
    expect(sel.end - sel.start).toBe(3); // "ABC"

    await page.keyboard.type("Z");
    await page.waitForTimeout(80);
    const value = await page.frameLocator("iframe.slide-frame").locator("body").evaluate((body) => {
      const doc = body.ownerDocument as Document;
      const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
      return (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value;
    });
    expect(value).toBe("HiZDE"); // [2,5) = "ABC" replaced by "Z"
  } finally {
    await cleanup();
  }
});

// F8 (NOOP-289 決定 T1) removed A4's own fixture mechanism: this test typed
// unbroken text ("aaaa bbbb cccc dddd", no "\n") into a narrow box and
// relied on the browser's own soft-wrap (core's wrapText, called live on
// every keystroke) to produce multiple tspans to select across. Decision
// T1 deletes that local-wrap-during-typing engine entirely — the SAME
// input now stays exactly one tspan (長行溢出文字框, spec #255's accepted
// regression), so `tspanCount` never exceeds 1 and the test's own premise
// ("this must actually wrap") no longer holds. A18 already covers the
// same concern — cross-line selection blocks with no gap/overlap at the
// seam — using the mechanism that still exists post-T1 (an explicit hard
// break via Enter), so this is dropped rather than reworked into a
// duplicate of A18.

it("A5：選取一段後 Backspace 整段刪除，Esc commit 只送一條命令，undo 一格回到原字串", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    let commandCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/command")) commandCount++;
    });

    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);
    await page.keyboard.type("ABCDE"); // -> "HiABCDE"
    await page.waitForTimeout(80);

    await dragSelectChars(page, "el-text", 2, 5); // selects "ABC" (indices 2..4)
    const dragSel = await readSelection(page);
    expect(dragSel.end - dragSel.start).toBe(3);

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);
    const value = await page.frameLocator("iframe.slide-frame").locator("body").evaluate((body) => {
      const doc = body.ownerDocument as Document;
      const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
      return (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value;
    });
    expect(value).toBe("HiDE"); // [2,5) = "ABC" deleted

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    expect(commandCount).toBe(1);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

// F8 (NOOP-289 決定 T1) removed A6's own fixture mechanism too, the same
// way as A4 above: it typed unbroken text expecting the deleted local-wrap
// engine to split it into multiple soft-wrapped tspans, then walked every
// character's click precision across that (now nonexistent) multi-tspan
// structure. A16–A19 already prove exactly this — per-character click →
// selectionStart precision across a MULTI-line `<text>` — using hard
// breaks (the mechanism T1 keeps), so this is dropped rather than
// reworked into a duplicate; A1 (single-line, no breaks at all) still
// covers the same invariant's simplest case.

it("A7：中文輸入法組字期間，游標不亂跳；組字中在編輯元素上按下不改變選取", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    const frame = page.frameLocator("iframe.slide-frame");
    const xs: number[] = [];
    // Simulate an IME composing "你好" one candidate character at a time —
    // compositionstart, then a growing composition string on each `input`,
    // never compositionend until the final step (ADR-0017 §4.4).
    await frame.locator("body").evaluate((body) => {
      const doc = body.ownerDocument as Document;
      const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const ta = host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
      ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    for (const partial of ["你", "你好"]) {
      await frame.locator("body").evaluate((body, partial) => {
        const doc = body.ownerDocument as Document;
        const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
        const ta = host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
        const base = "Hi";
        ta.value = base + partial;
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }, partial);
      await page.waitForTimeout(50);
      const caret = await readCaretRect(page);
      expect(caret).not.toBeNull();
      xs.push(caret!.left);
    }
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);

    const before = await readSelection(page);
    // Clicks the horizontal midpoint of the edited element itself, not a
    // specific character: the box's resize/rotate handles stay visible and
    // interactive during text edit, clustered within ~9px of its left/right
    // edges (ADR-0017 doesn't hide them mid-edit) — a point on the element
    // itself, away from those edges, is what a pointerdown-inside-the-edited-
    // element assertion needs, so this must land on the text rather than a
    // handle intercepting the click first.
    const elBox = await frame.locator("#el-text").boundingBox();
    if (!elBox) throw new Error("量不到 #el-text 的邊界框");
    await page.mouse.click(elBox.x + elBox.width / 2, elBox.y + elBox.height / 2);
    await page.waitForTimeout(50);
    expect(await readSelection(page)).toEqual(before);

    await frame.locator("body").evaluate((body) => {
      const doc = body.ownerDocument as Document;
      const host = doc.querySelector("[data-slidra-selection-host]") as HTMLElement;
      const ta = host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement;
      ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await page.waitForTimeout(50);
  } finally {
    await cleanup();
  }
});

// NOOP-65 §4.4 — Enter's new meaning: hard-break insertion while editing,
// keyboard-equivalent entry into editing when not, and ⌘Enter/Ctrl+Enter as
// the one no-op exception. `05-INTERACTIONS.feature`「就地編輯」was updated
// alongside this (the old "Enter 提交" line contradicted #199's multi-line
// scope — see NOOP-126 §0.2).

it("未編輯、選取單一文字框時按 Enter：進入編輯，游標在字串結尾（鍵盤等同雙擊）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-text").click();
    await page.keyboard.press("Enter");
    await waitForEditTextareaFocus(page);

    const selection = await readSelection(page);
    expect(selection.start).toBe(selection.end);
    expect(selection.start).toBe("Hi".length);
  } finally {
    await cleanup();
  }
});

it("編輯中按 Enter：游標處插入硬換行，不 commit、不離開編輯——整段編輯結束時仍只送一條命令", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    let commandCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/command")) commandCount++;
    });

    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await page.waitForTimeout(150);

    // Still editing — Enter must not have committed or left the session.
    expect(await isEditTextareaFocused(page)).toBe(true);
    const linesWhileEditing = await tspanCount(page, "el-text");
    expect(linesWhileEditing).toBeGreaterThanOrEqual(2); // the hard break forced at least 2 lines

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    expect(commandCount).toBe(1); // one `text set` for the whole session, not one per Enter
    const after = await readSlide(registry, presentationId);
    expect(after).toContain('data-slidra-break="1"');
    const lines = readTspans(after, "el-text");
    expect(lines.map((l) => l.text)).toEqual(["HiAAA", "BBB"]);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("編輯中按 ⌘Enter／Ctrl+Enter：不插入換行、不 commit、不離開編輯", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);

    let commandCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/command")) commandCount++;
    });

    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    await page.keyboard.type("XYZ");
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(150);

    expect(await isEditTextareaFocused(page)).toBe(true); // still editing
    expect(await tspanCount(page, "el-text")).toBe(1); // no hard break was inserted

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    expect(commandCount).toBe(1);
    const after = await readSlide(registry, presentationId);
    expect(readTspans(after, "el-text").map((l) => l.text)).toEqual(["HiXYZ"]);
  } finally {
    await cleanup();
  }
});

// A10（NOOP-65/#199 驗收條件第 3 條之二）：編輯中的文字框截圖比對。基準截圖
// 依 AGENTS.md「視覺回歸的把關分工」只能由 ubuntu-latest 上的 e2e.yml 產生；
// 本機一律 SKIP_APPEARANCE_BASELINES=1 跳過像素比對，只驗證互動流程本身真的
// 走到「準備好截圖」的狀態（仍在編輯中、游標落在第 2 行）。
it("A10：基準截圖：編輯中的文字框（多行、含硬換行）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await page.waitForTimeout(150);

    expect(await isEditTextareaFocused(page)).toBe(true); // 仍在編輯中
    expect(await readEditFrameDisplay(page)).toBe("block"); // 編輯框仍顯示

    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "editing-textbox", baselineDir });
  } finally {
    await cleanup();
  }
});
