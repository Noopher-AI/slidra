import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
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
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/plain-text-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-plain-text-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-plain-text-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

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
    await page.frameLocator("iframe.slide-frame").locator("#el-box").dblclick();
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

it("進入編輯後畫面看得出來：編輯外框與尾端游標都出現，游標隨打字往後移", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const frame = page.frameLocator("iframe.slide-frame");

    const decoration = () =>
      frame.locator("body").evaluate(() => {
        const shadow = document.querySelector("[data-comot-selection-host]")!.shadowRoot!;
        const caret = shadow.querySelector(".edit-caret") as HTMLElement;
        return {
          frame: (shadow.querySelector(".edit-frame") as HTMLElement).style.display,
          caret: caret.style.display,
          caretLeft: parseFloat(caret.style.left || "0"),
        };
      });

    expect((await decoration()).frame).not.toBe("block"); // Nothing being edited yet.

    await frame.locator("#el-plain").dblclick();
    await expect.poll(() => isEditTextareaFocused(page), { timeout: 10_000 }).toBe(true);

    const opened = await decoration();
    expect(opened.frame).toBe("block");
    expect(opened.caret).toBe("block");

    await page.keyboard.type("字");
    await expect.poll(async () => (await decoration()).caretLeft).toBeGreaterThan(opened.caretLeft);
  } finally {
    await cleanup();
  }
});

it("一般 <text>（沒有 data-comot-text-width）：雙擊可進入編輯，提交只換字串，x／y／text-anchor 原封不動", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-plain").dblclick();
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
