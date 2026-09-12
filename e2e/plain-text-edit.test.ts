import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * In-place text editing on the two shapes e2e/text-edit.test.ts's own
 * fixture never had: a text box whose <text> declares no `font-family`
 * (legal SVG — it used to be refused outright), and a plain <text> with no
 * `data-comot-text-width` at all (double-clicking it used to do nothing).
 *
 * The fixture deliberately embeds NO fonts: measuring the first shape then
 * has to reach the build's own bundled family over /api/default-font,
 * which is the whole point of that route.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/comotion");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/plain-text-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");
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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "comotion-e2e-plain-text-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "comotion-e2e-plain-text-files-"));
  process.env.COMOTION_HOME = coMotionHome;
  // [E4.T9]/F7: comotion serve now spawns the Rust binary for every read/write.
  process.env.COMOTION_BIN = coMotionBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckDir, comotPath);
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

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.COMOTION_HOME;
      delete process.env.COMOTION_BIN;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
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
  if (!match) throw new Error(`找不到 ${elementId} 的 <text>`);
  return match[1];
}

/** Whether the runtime's hidden edit textarea currently holds focus inside the sandboxed slide iframe. */
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

async function isEditTextareaFocused(page: Page): Promise<boolean> {
  return page
    .frameLocator("iframe.slide-frame")
    .locator("body")
    .evaluate(() => {
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement | null;
      const active = host?.shadowRoot?.activeElement;
      return !!active && active.tagName === "TEXTAREA";
    });
}

it("沒有 font-family 的文字框：雙擊可進入編輯，換行用內建預設字型量，提交後真的寫進檔案", async () => {
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

it("一般 <text>（沒有 data-comot-text-width）：雙擊可進入編輯，提交只換字串，x／y／text-anchor 原封不動", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-plain");
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    await page.keyboard.type("改過了");
    await page.keyboard.press("Escape");

    await expect
      .poll(async () => readTextMarkup(await readSlide(registry, presentationId), "el-plain"), { timeout: 10_000 })
      .toBe('<text x="640" y="500" text-anchor="middle" font-size="36" fill="#9aa7b4">一般文字改過了</text>');

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(readTextMarkup(await readSlide(registry, presentationId), "el-plain")).toBe(
      '<text x="640" y="500" text-anchor="middle" font-size="36" fill="#9aa7b4">一般文字</text>',
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
      const host = document.querySelector("[data-comot-selection-host]") as HTMLElement;
      return (host.shadowRoot!.querySelector("textarea") as HTMLTextAreaElement).value;
    });
}

// F-04 (NOOP-399): a plain <text> (no data-comot-text-width) used to stay a
// single DOM line while editing — Enter's hard break was invisible until
// Esc committed and the SVG-side re-layout split it into tspans. This
// proves the break is visible mid-edit (not just after commit), and that
// it survives the commit as two tspans, the second carrying no
// data-comot-break (only a line FOLLOWED by "\n" gets the marker).
it("F-04：Enter 插入的硬換行，編輯中立即可見、提交後兩個 tspan，第一個帶 data-comot-break", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-plain");
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    await page.keyboard.type("QA");
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");

    // Esc 前：畫面上 <text> 的直接子 tspan 已經是 2 個——換行當場看得到，
    // 不必等提交後 SVG 端重新排版。
    await expect
      .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-plain text > tspan").count(), {
        timeout: 10_000,
      })
      .toBe(2);

    await page.keyboard.press("Escape");

    await expect
      .poll(async () => readTextMarkup(await readSlide(registry, presentationId), "el-plain").includes("data-comot-break"), {
        timeout: 10_000,
      })
      .toBe(true);
    const markupAfterCommit = readTextMarkup(await readSlide(registry, presentationId), "el-plain");
    const tspans = [...markupAfterCommit.matchAll(/<tspan([^>]*)>([^<]*)<\/tspan>/g)];
    expect(tspans.length).toBe(2);
    expect(tspans[0][2]).toBe("一般文字QA");
    expect(tspans[0][1]).toContain('data-comot-break="1"');
    expect(tspans[1][2]).toBe("X");
    expect(tspans[1][1]).not.toContain("data-comot-break");
  } finally {
    await cleanup();
  }
});

// F-04b (NOOP-399): the read-back side of the same fix — a plain <text>
// that ALREADY has a hard break saved (`el-broken`, two tspans, the first
// carrying data-comot-break="1") must reconstruct the exact "\n" on the
// next edit. Before F-04b, `render_plain_text_content` never wrote
// data-comot-break at all, so slide-dom.ts's readTextContent (which only
// ever recognises that marker) saw two lines with nothing joining them and
// dropped the break the moment the box was re-opened. Fixture-seeded
// rather than chained onto F-04's own commit, to avoid racing the
// commit's own live-reload (`reload()` reassigns `iframe.srcdoc`, tearing
// down and rebuilding the runtime's shadow host/textarea — re-entering
// edit before that swap lands intermittently finds no `<textarea>` at all,
// verified directly).
it("F-04b：已存在的硬換行（data-comot-break）雙擊後，textarea 初值含 \\n", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await dblclickAtEnd(page, "el-broken");
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    expect(await readTextareaValue(page)).toBe("第一行\n第二行");
    await page.keyboard.press("Escape");
  } finally {
    await cleanup();
  }
});
