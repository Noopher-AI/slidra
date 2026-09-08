import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { requireBuilt, startServerFor, openApp, waitForAgentConnected, type StartedServer } from "./helpers/launch.js";

/**
 * NOOP-60/#197 驗收條件第 4 條：「Undo／Redo 按鈕與快捷鍵透過 CLI 生效，
 * agent 執行 `co-motion undo` 後 GUI 同步」。四個 case（Plan §6.2）：
 * 1. 按鈕；2. 快捷鍵；3. CLI→GUI 同步（不重新整理頁面，靠既有的 SSE
 * live-reload）；4. 凍結態（agent 持鎖時按鈕停用、快捷鍵不送請求）。
 *
 * 1–3 用 `demo/` 這份共用 fixture 的 `el-title`（純 `<text>`，見
 * demo/slides/001.svg）：`registry.dispatch("text set", ...)` 直接改它，
 * 不需要在瀏覽器裡雙擊進入編輯——undo/redo 的按鈕與同步路徑跟「文字是怎麼
 * 被改的」無關，這裡只驗 undo/redo 本身。
 *
 * 4 沿用 e2e/freeze.test.ts 既有的假 ACP agent fixture
 * （editing-fake-acp-agent.mjs）與凍結流程，量測「按鈕 disabled + Ctrl+Z
 * 不送 /api/undo」，不重複量測伺服器端的凍結語意本身
 * （packages/server/test/agent/freeze.test.ts 已經覆蓋）。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const binDir = path.join(rootDir, "node_modules/.bin");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
// editing-fake-acp-agent.mjs 要求 `<text id="...">` id 直接掛在 <text> 本身
// （extractTextElementId），demo/ 的 <text> 沒有 id（id 只掛在外層 <g>）——
// 凍結態測試改用 e2e/freeze.test.ts 同一份 fixture deck，其他三個 case
// 仍用 demo/（不需要餵給假 agent，直接用 registry.dispatch 改文字）。
const frozenDeckDir = path.join(e2eDir, "fixtures/player-deck");
const VIEWPORT = { width: 1440, height: 900 };
const SLIDE_PATH = "slides/001.svg";
const ELEMENT_ID = "el-title";
const ORIGINAL_TEXT = "驗收用簡報";
const NEW_TEXT = "驗收用簡報（改過）";

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function start(prefix: string): Promise<{ started: StartedServer; page: Page }> {
  const started = await startServerFor({ deckDir: demoDir, prefix });
  const page = await openApp(browser, started.server, { viewport: VIEWPORT });
  openPages.push(page);
  return { started, page };
}

async function iframeTitleText(page: Page): Promise<string | null> {
  return page.frameLocator("iframe.slide-frame").locator(`#${ELEMENT_ID} text`).textContent().catch(() => null);
}

async function setTitle(registry: CommandRegistry, presentationId: string, text: string): Promise<void> {
  const result = await registry.dispatch("text set", {
    id: presentationId,
    slidePath: SLIDE_PATH,
    elementId: ELEMENT_ID,
    newText: text,
  });
  if (!result.ok) throw new Error(result.message);
}

it("按鈕：Titlebar ↶ 讓 registry.dispatch 改過的文字回到原值", async () => {
  const { started, page } = await start("undo-redo-button");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    await page.locator('.titlebar-icon-button[aria-label="Undo"]').click();
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(ORIGINAL_TEXT);
  } finally {
    await started.cleanup();
  }
});

it("快捷鍵：⌘Z/⇧⌘Z 走同一條路徑", async () => {
  const { started, page } = await start("undo-redo-shortcut");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    await page.locator(".titlebar").click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(ORIGINAL_TEXT);

    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);
  } finally {
    await started.cleanup();
  }
});

it("快捷鍵：點過舞台元素（焦點在 iframe 內）後直接按 ⌘Z 仍可 undo（#198）", async () => {
  const { started, page } = await start("undo-redo-shortcut-after-stage-click");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    // 點 iframe 內的元素把鍵盤焦點留在 iframe 裡——不點 .titlebar，這正是
    // 既有那條「快捷鍵」測試繞開的坑。等狀態列的選取 chip 出現，確認點擊
    // 真的落在舞台上。
    await page.frameLocator("iframe.slide-frame").locator(`#${ELEMENT_ID}`).click();
    await expect.poll(() => page.locator(".status-selection-chip").textContent().then((t) => t?.trim() ?? null)).toContain("Selected:");

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(ORIGINAL_TEXT);

    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);
  } finally {
    await started.cleanup();
  }
});

it("CLI ↔ GUI 同步：agent 執行 co-motion undo（registry.dispatch(\"undo\")）後，不重新整理頁面 GUI 也自己變回原值", async () => {
  const { started, page } = await start("undo-redo-cli-sync");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    // 模擬 agent 下 `co-motion undo`：直接呼叫 registry，不經過瀏覽器。
    const undo = await started.registry.dispatch("undo", { id: started.presentationId });
    expect(undo.ok).toBe(true);

    // 不 page.reload()：靠既有的 file watcher → SSE /api/events →
    // live-reload.ts → controller.reload() 這條鏈自己把畫面同步回來。
    await expect.poll(() => iframeTitleText(page), { timeout: 30_000 }).toBe(ORIGINAL_TEXT);
  } finally {
    await started.cleanup();
  }
});

// ── 凍結態：沿用 e2e/freeze.test.ts 的假 ACP agent fixture ──────────────

async function startFrozenServer(): Promise<{ server: RunningServer; registry: CommandRegistry; presentationId: string; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-undoredo-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-undoredo-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(frozenDeckDir, comotPath);
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
      E2E_NEW_TITLE: "凍結測試不看這個標題",
      E2E_FREEZE_HOLD_MS: "3000",
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

async function editingFrozen(page: Page): Promise<boolean> {
  const banner = await page.locator(".editing-frozen-banner").count();
  return banner > 0;
}

it("凍結態：agent 持鎖時 Undo/Redo 按鈕停用，⌘Z 不送出 /api/undo 請求", async () => {
  const frozen = await startFrozenServer();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    openPages.push(page);
    const undoRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/undo")) undoRequests.push(request.url());
    });
    await page.goto(frozen.server.url);
    await page.frameLocator("iframe.slide-frame").locator("svg text").first().waitFor({ timeout: 30_000 });
    await waitForAgentConnected(page);

    await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
    await page.locator(".chat-input textarea").fill("改標題");
    await page.locator(".chat-input button").click();

    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(true);
    expect(await page.locator('.titlebar-icon-button[aria-label="Undo"]').isDisabled()).toBe(true);
    expect(await page.locator('.titlebar-icon-button[aria-label="Redo"]').isDisabled()).toBe(true);

    await page.locator(".titlebar").click();
    await page.keyboard.press("ControlOrMeta+z");
    expect(undoRequests).toEqual([]);

    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);
  } finally {
    await frozen.cleanup();
  }
});
