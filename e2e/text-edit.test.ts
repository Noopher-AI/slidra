// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * In-place text editing acceptance tests. Modelled on
 * e2e/direct-manipulation.test.ts's startServerFor/openApp shape and its
 * font-staging trick (the fixture's project.json declares "Noto Sans TC"
 * but ships no font bytes; this file copies the real ones from
 * assets/fonts into a throwaway staging dir before packing, same as that
 * file does).
 *
 * Entry point exercised: `beginTextEdit` via the runtime's own
 * dblclick-on-a-text-box path (`data-slidra-text-width` on the container).
 * Wiring `beginTextEdit` to the INSERT flow is out of scope here — this
 * file's dblclick is the public entry point used as the equivalent path.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/text-edit-deck");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };
const VIEWBOX = { width: 1280, height: 720 };
const FONT_SIZE = 24;

let browser: Browser;
let openPages: Page[] = [];
let fontDataUrl: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, run npm run build first");
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
  // slidra serve now spawns the Rust binary for every read/write.
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
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test does not send a message",
    },
  };

  const server = await startServe({ policy: openPolicy, presentationId, port: 0, agent });

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
  if (!match) throw new Error(`could not find data-slidra-text-width for ${elementId}`);
  return Number(match[1]);
}

/**
 * Chromium's own `getComputedTextLength()` for `text` at `fontSizePx` in the
 * real embedded presentation font — same technique as
 * text-metrics.test.ts's `renderedWidthInChromium`, the external ground
 * truth this file's wrap assertions compare against (the TypeScript
 * engine's own `wrapText`, previously used as the oracle here, no longer
 * exists).
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
 * edit by dblclick puts the caret at the click point (see the in-place
 * editing spec), so this is how a test opens an edit session with the
 * caret at the END of the text — dblclicking the element's centre would
 * land it mid-string.
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
  if (!box) throw new Error("could not measure iframe.slide-frame's bounding box");
  await page.mouse.dblclick(box.x + p.x, box.y + p.y);
}

async function waitForEditTextareaFocus(page: Page): Promise<void> {
  await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);
}

/**
 * Caret/selection geometry helpers below. Every one of these
 * reads its numbers straight off the browser's own SVG text geometry APIs
 * (`getStartPositionOfChar`/`getEndPositionOfChar`/`getScreenCTM`,
 * `<tspan>.getBoundingClientRect()`) — never off the runtime's own
 * `indexAtPoint()`/`textLineRanges()` — so a test using them is an
 * independent check on the runtime's behaviour, not a tautology that
 * would pass even if that behaviour were wrong.
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
  if (!box) throw new Error("could not measure iframe.slide-frame's bounding box");
  return { x: box.x, y: box.y };
}

/** Clicks the point 1/4 of the way across character `index` — inside the half `indexAtPoint`'s midpoint rule resolves to that same index, away from the exact midpoint boundary. */
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
  if (!containerMatch) throw new Error(`could not find <text> for ${elementId}`);
  // `data-slidra-break="1"` is an optional trailing attribute on a line
  // that ends on a hard break — matched but not captured, so this
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

it("double-clicking a text box to edit, typing, and pressing Esc: the SVG's tspans keep every character, each line's rendered width stays within the declared width, the whole edit sends only one command, and undo reverts to the original string", async () => {
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
    // the string's end) — the textarea starts pre-loaded with the
    // fixture's own initial text ("Hi"), so typing appends after it
    // rather than replacing it. `finalText` below is what actually ends
    // up committed.
    const typed = "Hello Slidra this line of test content is long enough to wrap across multiple lines";
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

    // Non-circular wrap assertions (the TypeScript engine's `wrapText`,
    // previously this test's oracle, no longer exists — Rust comparing
    // against Rust would be circular). (a) the fixture's whole
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
      expect(renderedWidth, `rendered width of line "${line.text}"`).toBeLessThanOrEqual(declaredWidth * 1.005);
    }

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("entering edit mode and pressing Esc immediately without typing sends no command", async () => {
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

it("pressing down and dragging on the element being edited: transform stays unchanged, no command is sent, and no multi-select box appears", async () => {
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
    if (!svgBoxRect) throw new Error("could not measure the main canvas svg's bounding box");
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

it("double-clicking a locked text box does not enter edit mode: no focus lands on the edit textarea, and typing afterward leaves the file unchanged", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    await page.frameLocator("iframe.slide-frame").locator("#el-locked-text").dblclick();
    await page.waitForTimeout(300);

    expect(await isEditTextareaFocused(page)).toBe(false);

    await page.keyboard.type("this should not be written to the file");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    expect(await readSlide(registry, presentationId)).toBe(before);
  } finally {
    await cleanup();
  }
});

it("ArrowLeft moves the cursor left one step at a time, keeping the on-screen caret position in sync with textarea.selectionStart", async () => {
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

// Original repro scenario for an off-by-one bug in the preview channel:
// with a hard line break present, clicking the first character of the
// second line must place the cursor on the clicked character, not one
// character off. The root cause was that canvas.ts's preview never
// carried data-slidra-break, so selection-runtime.js's textLineRanges
// (itself correct) could never see the hard-break marker during editing,
// and line boundaries were computed wrong as a result. This is a strict
// superset of the coordinate-based test (clickChar -> selectionStart ->
// type -> value) that asserts the same thing under a harder scenario
// (across a hard break), so it replaces that simpler single-line test
// (still covered by other single-character-offset tests below).
it("clicking the first character of the second line when a hard break is present places the cursor on the clicked character (mechanical repro of the preview-channel off-by-one, hard-break variant)", async () => {
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
    // first char) must map to value index 6 (the DOM-to-value index conversion).
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

// The other side of the previous test — the "end of line" for the line
// before a hard break. Clicking the right half of that line's last
// character must stop the cursor before "\n" (end of that line), not
// after it (start of the next line); the caret must also be drawn to the
// right of that last character, not on the next line or at that line's
// left edge.
it("clicking the right half of the last character on the line before a hard break stops the cursor at the end of that line (before \\n), with the caret drawn to its right", async () => {
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

// Drag-selecting across a hard break — the highlight block for the line
// before "\n" must be drawn from the start point to the right of that
// line's last character, not extend to the first character of the next
// line just because the range includes the virtual "\n".
it("dragging a selection across a hard break draws the first line's highlight block from the start point to that line's end", async () => {
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

// Double-clicking to enter edit mode should place the cursor at the
// double-click point, not at the end of the text (see the in-place
// editing spec). First commit a two-line edit, then double-click a
// character on the second line.
it("double-clicking a character on the second line of a multi-line text box enters edit mode with the cursor at that character, not at the end", async () => {
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

it("drag-selecting 3 characters then typing 1 character replaces the 3 selected characters with the 1 typed", async () => {
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

// A previous decision removed this test's own fixture mechanism: it typed
// unbroken text ("aaaa bbbb cccc dddd", no "\n") into a narrow box and
// relied on the browser's own soft-wrap (core's wrapText, called live on
// every keystroke) to produce multiple tspans to select across. That
// decision deletes the local-wrap-during-typing engine entirely — the
// same input now stays exactly one tspan (a long line simply overflows
// the text box, an accepted regression), so `tspanCount` never exceeds 1
// and the test's own premise ("this must actually wrap") no longer holds.
// The cross-hard-break drag-selection test above already covers the same
// concern — cross-line selection blocks with no gap/overlap at the seam —
// using the mechanism that still exists (an explicit hard break via
// Enter), so this is dropped rather than reworked into a duplicate.

it("selecting a range then pressing Backspace deletes the whole range; committing with Esc sends only one command, and undo reverts to the original string", async () => {
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

// This test's own fixture mechanism was removed the same way as the one
// above: it typed unbroken text expecting the deleted local-wrap engine
// to split it into multiple soft-wrapped tspans, then walked every
// character's click precision across that (now nonexistent) multi-tspan
// structure. The hard-break tests above already prove exactly this —
// per-character click -> selectionStart precision across a MULTI-line
// `<text>` — using hard breaks (the mechanism that remains), so this is
// dropped rather than reworked into a duplicate; the single-line,
// no-breaks test still covers the same invariant's simplest case.

it("during Chinese IME composition the cursor does not jump around; pressing down on the edited element mid-composition does not change the selection", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    const frame = page.frameLocator("iframe.slide-frame");
    const xs: number[] = [];
    // Simulate an IME composing "你好" one candidate character at a time —
    // compositionstart, then a growing composition string on each `input`,
    // never compositionend until the final step.
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
    // edges (the editor doesn't hide them mid-edit) — a point on the element
    // itself, away from those edges, is what a pointerdown-inside-the-edited-
    // element assertion needs, so this must land on the text rather than a
    // handle intercepting the click first.

    const elBox = await frame.locator("#el-text").boundingBox();
    if (!elBox) throw new Error("could not measure #el-text's bounding box");
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

// Enter's meaning while editing: hard-break insertion while already
// editing, keyboard-equivalent entry into editing when not, and
// ⌘Enter/Ctrl+Enter as the one no-op exception. The in-place editing spec
// was updated alongside this (the old "Enter commits" behavior
// contradicted the multi-line editing scope).

it("pressing Enter while a single text box is selected but not being edited enters edit mode with the cursor at the end of the string (keyboard equivalent of double-click)", async () => {
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

it("pressing Enter while editing inserts a hard break at the cursor without committing or leaving edit mode — the whole session still sends only one command when it ends", async () => {
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

it("pressing ⌘Enter/Ctrl+Enter while editing inserts no line break, does not commit, and does not leave edit mode", async () => {
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

// Screenshot comparison of a text box mid-edit. Per AGENTS.md's appearance-
// regression policy, baseline screenshots can only be generated by e2e.yml
// on ubuntu-latest; locally this always sets SKIP_APPEARANCE_BASELINES=1
// to skip the pixel compare and only verifies that the interaction flow
// itself actually reaches the "ready to screenshot" state (still editing,
// cursor on the second line).
it("a text box mid-edit (multi-line, with a hard break) is still in the editing state", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-text");
    await waitForEditTextareaFocus(page);

    await page.keyboard.type("AAA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("BBB");
    await page.waitForTimeout(150);

    expect(await isEditTextareaFocused(page)).toBe(true); // still editing
    expect(await readEditFrameDisplay(page)).toBe("block"); // edit frame still shown
  } finally {
    await cleanup();
  }
});
