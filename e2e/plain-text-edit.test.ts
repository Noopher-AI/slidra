// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { connectDeckServerRegistry, createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * In-place text editing on the two shapes e2e/text-edit.test.ts's own
 * fixture never had: a text box whose <text> declares no `font-family`
 * (legal SVG — it used to be refused outright), and a plain <text> with no
 * `data-slidra-text-width` at all (double-clicking it used to do nothing).
 *
 * The fixture deliberately embeds NO fonts: measuring the first shape then
 * has to reach the build's own bundled family over /api/default-font,
 * which is the whole point of that route.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/plain-text-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, run npm run build first");
  browser = await chromium.launch();
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
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-plain-text-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-plain-text-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckDir, slidraPath);
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
      E2E_NEW_TITLE: "this test never sends a message",
    },
  };

  const server = await startServe({ policy: openPolicy, presentationId: slidraPath, port: 0, agent });
  const live = await connectDeckServerRegistry(server.url);

  return {
    server,
    registry: live.registry,
    presentationId: live.presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
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

/** The `<text>` markup inside `elementId`'s own container, opening tag included. */
function readTextMarkup(svg: string, elementId: string): string {
  const match = new RegExp(`<g id="${elementId}"[^>]*>\\s*(<text[^>]*>[\\s\\S]*?</text>)`).exec(svg);
  if (!match) throw new Error(`could not find <text> for ${elementId}`);
  return match[1];
}

/** Whether the runtime's hidden edit textarea currently holds focus inside the sandboxed slide iframe. */
/**
 * Double-clicks the right half of `elementId`'s last character. Entering
 * edit by dblclick puts the caret at the click point (in-place editing), so
 * this is how a test opens an edit session with the caret at the END of the
 * text — dblclicking the element's centre would land it mid-string.
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

async function isEditTextareaFocused(page: Page): Promise<boolean> {
  return page
    .frameLocator("iframe.slide-frame")
    .locator("body")
    .evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement | null;
      const active = host?.shadowRoot?.activeElement;
      return !!active && active.tagName === "TEXTAREA";
    });
}

it("a text box with no font-family: double-click enters edit mode, line wrapping is measured with the bundled default font, and committing writes to the file", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-box");
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    await page.keyboard.type("一二三四五六七八九十一二三四五六");
    await page.keyboard.press("Escape");

    await expect
      .poll(async () => readTextMarkup(await readSlide(registry, presentationId), "el-box").includes("起頭一二三"), {
        timeout: 10_000,
      })
      .toBe(true);

    // width 200 / font-size 24 cannot fit 18 CJK glyphs on one line, so a
    // real measurement must have happened — the point of the whole route.
    const markup = readTextMarkup(await readSlide(registry, presentationId), "el-box");
    expect(markup.match(/<tspan /g)?.length ?? 0).toBeGreaterThan(1);
  } finally {
    await cleanup();
  }
});

it("a plain <text> (no data-slidra-text-width): double-click enters edit mode, committing only swaps the string, x/y/text-anchor stay untouched", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-plain");
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    await page.keyboard.type(" edited");
    await page.keyboard.press("Escape");

    await expect
      .poll(async () => readTextMarkup(await readSlide(registry, presentationId), "el-plain"), { timeout: 10_000 })
      .toBe('<text x="640" y="500" text-anchor="middle" font-size="36" fill="#9aa7b4">Plain text edited</text>');

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(readTextMarkup(await readSlide(registry, presentationId), "el-plain")).toBe(
      '<text x="640" y="500" text-anchor="middle" font-size="36" fill="#9aa7b4">Plain text</text>',
    );
  } finally {
    await cleanup();
  }
});

/** The runtime's hidden edit textarea's current `.value`, inside the sandboxed slide iframe. */
async function readTextareaValue(page: Page): Promise<string> {
  return page
    .frameLocator("iframe.slide-frame")
    .locator("body")
    .evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement;
      return (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value;
    });
}

// A plain <text> (no data-slidra-text-width) used to stay a single DOM line
// while editing — Enter's hard break was invisible until Esc committed and
// the SVG-side re-layout split it into tspans. This proves the break is
// visible mid-edit (not just after commit), and that it survives the commit
// as two tspans, the second carrying no data-slidra-break (only a line
// FOLLOWED by "\n" gets the marker).
it("a hard line break inserted with Enter is visible immediately while editing, and commits as two tspans, the first carrying data-slidra-break", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-plain");
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    await page.keyboard.type("QA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");

    // Before Esc: the on-screen <text>'s direct child tspans are already 2 —
    // the break is visible right away, no need to wait for the post-commit
    // SVG-side re-layout.
    await expect
      .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-plain text > tspan").count(), {
        timeout: 10_000,
      })
      .toBe(2);

    await page.keyboard.press("Escape");

    await expect
      .poll(async () => readTextMarkup(await readSlide(registry, presentationId), "el-plain").includes("data-slidra-break"), {
        timeout: 10_000,
      })
      .toBe(true);
    const markupAfterCommit = readTextMarkup(await readSlide(registry, presentationId), "el-plain");
    const tspans = [...markupAfterCommit.matchAll(/<tspan([^>]*)>([^<]*)<\/tspan>/g)];
    expect(tspans.length).toBe(2);
    expect(tspans[0][2]).toBe("Plain textQA");
    expect(tspans[0][1]).toContain('data-slidra-break="1"');
    expect(tspans[1][2]).toBe("X");
    expect(tspans[1][1]).not.toContain("data-slidra-break");
  } finally {
    await cleanup();
  }
});

// The read-back side of the same fix — a plain <text> that ALREADY has a
// hard break saved (`el-broken`, two tspans, the first carrying
// data-slidra-break="1") must reconstruct the exact "\n" on the next edit.
// Before this fix, `render_plain_text_content` never wrote data-slidra-break
// at all, so slide-dom.ts's readTextContent (which only ever recognises that
// marker) saw two lines with nothing joining them and dropped the break the
// moment the box was re-opened. Fixture-seeded rather than chained onto the
// previous test's own commit, to avoid racing the commit's own live-reload
// (`reload()` reassigns `iframe.srcdoc`, tearing down and rebuilding the
// runtime's shadow host/textarea — re-entering edit before that swap lands
// intermittently finds no `<textarea>` at all, verified directly).
it("an existing hard break (data-slidra-break) survives into the textarea's initial value on double-click, containing \\n", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-broken");
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    expect(await readTextareaValue(page)).toBe("Line one\nLine two");
    await page.keyboard.press("Escape");
  } finally {
    await cleanup();
  }
});
