import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory, resolvePresentationFonts, wrapText } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * NOOP-144/NOOP-177 (Plan: NOOP-174) — in-place text editing acceptance
 * tests. Modelled on e2e/direct-manipulation.test.ts's startServerFor/
 * openApp shape and its font-staging trick (the fixture's project.json
 * declares "Noto Sans TC" but ships no font bytes; this file copies the
 * real ones from packages/core/src/assets/fonts into a throwaway staging
 * dir before packing, same as that file does).
 *
 * Entry point exercised: `beginTextEdit` via the runtime's own
 * dblclick-on-a-text-box path (`data-comot-text-width` on the container) —
 * per NOOP-174's plan, wiring `beginTextEdit` to the INSERT flow is out of
 * scope for this ticket (T2/NOOP-159); this file's dblclick IS the public
 * entry point NOOP-174 designates as the equivalent path for AC1.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/text-edit-deck");
const presentationFontDir = path.join(rootDir, "packages/core/src/assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };
const VIEWBOX = { width: 1280, height: 720 };
const TEXT_WIDTH = 220;
const FONT_SIZE = 24;

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-text-edit-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-text-edit-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-text-edit-deck-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  await cp(deckDir, deckStagingDir, { recursive: true });
  await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
  await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckStagingDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
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

  const server = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
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

/** Whether the runtime's hidden edit textarea currently has document focus inside the sandboxed slide iframe — the signal that `begin-text-edit`'s async round trip (font fetch included) has actually landed. */
async function isEditTextareaFocused(page: Page): Promise<boolean> {
  const frame = page.frameLocator("iframe.slide-frame");
  return frame.locator("body").evaluate(() => {
    const host = document.querySelector("[data-comot-selection-host]") as HTMLElement | null;
    const active = host?.shadowRoot?.activeElement;
    return !!active && active.tagName === "TEXTAREA";
  });
}

async function waitForEditTextareaFocus(page: Page): Promise<void> {
  await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);
}

/** `<tspan x="0" y="…">…</tspan>` entries inside `elementId`'s own `<text>`, in document order. */
function readTspans(svg: string, elementId: string): { text: string; y: number }[] {
  const containerMatch = new RegExp(`<g id="${elementId}"[^>]*>\\s*<text[^>]*>([\\s\\S]*?)</text>`).exec(svg);
  if (!containerMatch) throw new Error(`找不到 ${elementId} 的 <text>`);
  const tspanRe = /<tspan x="0" y="([-\d.]+)">([^<]*)<\/tspan>/g;
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

it("雙擊文字框進入編輯、打字、Esc 離開：SVG 的 tspan 逐行與 wrapText 算出的一致，整段編輯只送一條命令，undo 一格回到原字串（AC1/AC2）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const before = await readSlide(registry, presentationId);
    const page = await openApp(server);

    let commandCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/command")) commandCount++;
    });

    await page.frameLocator("iframe.slide-frame").locator("#el-text").dblclick();
    await waitForEditTextareaFocus(page);

    // The editing model has no caret/selection (only append/backspace at
    // the string's end, §7 決定 6) — the textarea starts pre-loaded with
    // the fixture's own initial text ("Hi"), so typing appends after it
    // rather than replacing it. `finalText` below is what actually ends
    // up committed.
    const typed = "Hello CoMotion 文字框就地編輯測試內容一二三四五六七八九十";
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

    const fonts = await resolvePresentationFonts(presentationId);
    const font = fonts.get("Noto Sans TC")!;
    const expectedWrap = wrapText(finalText, { width: TEXT_WIDTH, font, fontSizePx: FONT_SIZE });

    expect(actualLines.length).toBe(expectedWrap.lines.length);
    expect(actualLines.length).toBeGreaterThan(1); // The fixture's whole point: this text must actually wrap.
    for (let i = 0; i < expectedWrap.lines.length; i++) {
      expect(actualLines[i].text).toBe(expectedWrap.lines[i].text);
      expect(actualLines[i].y).toBeCloseTo(expectedWrap.lines[i].y, 3);
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

    await page.frameLocator("iframe.slide-frame").locator("#el-text").dblclick();
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

    await page.frameLocator("iframe.slide-frame").locator("#el-text").dblclick();
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
      const selHost = doc?.querySelector("[data-comot-selection-host]") as HTMLElement | null;
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
