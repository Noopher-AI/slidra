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
 * 側邊面板分頁化 (NOOP-271/#154). Real Chromium + real server, modeled on
 * e2e/style-panel.test.ts's startServerFor/openApp shape and reusing its
 * fixture deck (e2e/fixtures/style-panel-deck) — this suite only needs
 * elements to select, not any style-panel-specific content.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/style-panel-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-sidepanel-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-sidepanel-files-"));
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

async function enterPlay(page: Page): Promise<void> {
  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
}

it("A1：右側同時只有一個面板容器，兩個面板不再並排出現在 DOM", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    expect(await page.locator(".side-panel").count()).toBe(1);
    expect(await page.locator(".chat-sidebar").count()).toBe(1);
    expect(await page.locator(".style-panel").count()).toBe(0);

    await page.locator('.side-panel-tab[data-tab="style"]').click();
    expect(await page.locator(".chat-sidebar").count()).toBe(0);
    expect(await page.locator(".style-panel").count()).toBe(1);
  } finally {
    await cleanup();
  }
});

it("A2：分頁列有「對話」「樣式」兩個 role=tab 標籤，方向鍵可切換且 roving tabindex 正確", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const tabs = page.locator(".side-panel-tabs").getByRole("tab");
    await expect.poll(() => tabs.count()).toBe(2);
    expect(await page.locator('.side-panel-tab[data-tab="chat"]').textContent()).toContain("對話");
    expect(await page.locator('.side-panel-tab[data-tab="style"]').textContent()).toContain("樣式");

    const chatTab = page.locator("#side-panel-tab-chat");
    const styleTab = page.locator("#side-panel-tab-style");
    expect(await chatTab.getAttribute("aria-selected")).toBe("true");
    expect(await styleTab.getAttribute("aria-selected")).toBe("false");
    expect(await chatTab.getAttribute("tabindex")).toBe("0");
    expect(await styleTab.getAttribute("tabindex")).toBe("-1");

    await chatTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => styleTab.getAttribute("aria-selected")).toBe("true");
    expect(await chatTab.getAttribute("aria-selected")).toBe("false");
    expect(await chatTab.getAttribute("tabindex")).toBe("-1");
    expect(await styleTab.getAttribute("tabindex")).toBe("0");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("side-panel-tab-style");

    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => chatTab.getAttribute("aria-selected")).toBe("true");
  } finally {
    await cleanup();
  }
});

it("A3：開檔後預設停在「對話」", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    expect(await page.locator("#side-panel-tab-chat").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator(".chat-sidebar").count()).toBe(1);
  } finally {
    await cleanup();
  }
});

it("A4：選取記號隨選取數變化，不觸發分頁切換", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const styleTab = page.locator('.side-panel-tab[data-tab="style"]');
    const badge = styleTab.locator(".side-panel-badge");

    expect(await badge.count()).toBe(0);

    await slideFrame.locator("#el-a").click();
    const selName = page.locator(".status .sel-name");
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：方塊 A");
    await expect.poll(() => badge.textContent()).toBe("1");
    expect(await styleTab.getAttribute("aria-selected")).toBe("false");
    expect(await page.locator("#side-panel-tab-chat").getAttribute("aria-selected")).toBe("true");

    await slideFrame.locator("#el-b").click({ modifiers: ["Shift"] });
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("已選取：2 個元素");
    await expect.poll(() => badge.textContent()).toBe("2");

    // 點畫面上沒有元素的空白角落取消選取 — 沿用 e2e/selection.test.ts「點空白處取消選取」的做法。
    const svgRoot = slideFrame.locator("svg").first();
    const box = await svgRoot.boundingBox();
    if (!box) throw new Error("量不到 svg 的邊界框");
    await page.mouse.click(box.x + 4, box.y + 4);
    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("");
    await expect.poll(() => badge.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("A5：在「對話」輸入到一半時點選畫布元素，輸入內容不遺失、分頁不變", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const draftInput = page.locator(".chat-input input");
    await draftInput.fill("測試草稿");

    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();

    expect(await draftInput.inputValue()).toBe("測試草稿");
    expect(await page.locator("#side-panel-tab-chat").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator(".chat-sidebar").count()).toBe(1);
  } finally {
    await cleanup();
  }
});

it("A7'：.canvas-area 寬度改動前後不變（928px），高度因對話不再佔第二列而增加", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    const canvasArea = page.locator(".canvas-area");
    const box = await canvasArea.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBe(928);
    expect(box!.height).toBeGreaterThan(551);

    const rows = await page.locator(".body").evaluate((el) => getComputedStyle(el).gridTemplateRows);
    expect(rows.trim().split(/\s+/).length).toBe(1);

    // .side-panel（含分頁列）本身的 y 應與 .main 對齊；.chat-sidebar 因為
    // 分頁列（--h-tabs）而往下再偏一點，是預期內的，不是回歸。
    const sidePanelBox = await page.locator(".side-panel").boundingBox();
    const mainBox = await page.locator(".main").boundingBox();
    expect(Math.round(sidePanelBox!.y)).toBe(Math.round(mainBox!.y));
  } finally {
    await cleanup();
  }
});

it("A8：播放模式下整個面板容器不在 DOM 裡", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    expect(await page.locator(".side-panel").count()).toBe(1);

    await enterPlay(page);

    expect(await page.locator(".side-panel").count()).toBe(0);
    expect(await page.locator(".chat-sidebar").count()).toBe(0);
    expect(await page.locator(".style-panel").count()).toBe(0);
  } finally {
    await cleanup();
  }
});
