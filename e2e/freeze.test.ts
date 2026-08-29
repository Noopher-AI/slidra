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
 * T5 (NOOP-93/#110), 接縫三: Ctrl+Z's granularity and the editing freeze,
 * driven in a real browser against a real server. Server-side grouping/
 * freeze-window behaviour (AC1, AC2, AC4) is covered exhaustively over HTTP
 * in packages/server/test/agent/freeze.test.ts — this file only exercises
 * what needs an actual browser: AC3 ("frozen still browses") and the
 * Ctrl+Z keyboard path.
 *
 * The agent is `editing-fake-acp-agent.mjs`, the same fixture
 * e2e/smoke.test.ts and e2e/player.test.ts already use, given
 * `E2E_FREEZE_HOLD_MS` so the freeze window is long enough to reliably
 * assert against in a real browser instead of racing a turn that would
 * otherwise complete within a couple of event-loop ticks.
 *
 * Each test gets its own fresh presentation and server (modeled on
 * e2e/selection.test.ts's startServerFor) — sharing one across tests would
 * let one test's undo/title state leak into the next.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/player-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const NEW_TITLE = "凍結測試改過的標題";
const FREEZE_HOLD_MS = 1500;

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

async function startServerFor(): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-freeze-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-freeze-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "player-deck.comot");
  await packDirectory(deckFixtureDir, comotPath);
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
      E2E_NEW_TITLE: NEW_TITLE,
      E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS),
    },
  };

  const server = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer): Promise<{ page: Page; pageErrors: string[] }> {
  const page = await browser.newPage();
  openPages.push(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(server.url);
  return { page, pageErrors };
}

function currentSlideTextOf(page: Page, pageErrors: string[]): () => Promise<string | null> {
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  return async () => {
    if (pageErrors.length > 0) return `頁面錯誤：${pageErrors.join("; ")}`;
    return slideText.textContent().catch(() => null);
  };
}

async function editingFrozen(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const response = await fetch("/api/editing");
    const data = (await response.json()) as { frozen: boolean };
    return data.frozen;
  });
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
  await page.locator(".chat-input input").fill(text);
  await page.locator(".chat-input button").click();
}

it("凍結期間仍可翻頁、進出播放模式；解凍後標題確實已更新（AC3）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const { page, pageErrors } = await openApp(server);
    const currentSlideText = currentSlideTextOf(page, pageErrors);
    const nextButton = page.locator('.slide-nav-button[aria-label="下一頁"]');
    const previousButton = page.locator('.slide-nav-button[aria-label="上一頁"]');

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    await sendChatMessage(page, "改標題");
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(true);

    // 翻頁：凍結不擋瀏覽。
    await nextButton.click();
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第二頁");
    expect(await editingFrozen(page)).toBe(true);

    await previousButton.click();
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    // 進播放模式：凍結不擋瀏覽。
    await page.locator('.view-btn[data-view="play"]').click();
    await page.locator(".play-bar-position").waitFor({ timeout: 30_000 });
    expect(await editingFrozen(page)).toBe(true);

    // 離開播放，回到檢視模式。
    await page.locator(".play-toggle-button.leave").click();
    await page.locator(".play-bar-position").waitFor({ state: "detached", timeout: 30_000 });

    // 整段瀏覽期間，agent 這回合都還沒結束——現在才等它結束、確認標題真的變了。
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(NEW_TITLE);

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("Ctrl/Cmd+Z 在解凍後可用，能把 agent 這一回合做的修改復原（顆粒度：接縫三對照的是伺服器測試裡的多命令分組行為）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const { page, pageErrors } = await openApp(server);
    const currentSlideText = currentSlideTextOf(page, pageErrors);

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    await sendChatMessage(page, "改標題");
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(NEW_TITLE);
    // The turn is over by now (currentSlideText already observed its final
    // effect), so this Ctrl+Z exercises the ordinary, unfrozen path.
    await expect.poll(() => editingFrozen(page)).toBe(false);

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});
