import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import type { AgentKind } from "../packages/server/src/agent/adapters.js";
import type { CommandOutcome, CommandRunner } from "../packages/server/src/agent/probe.js";
import { openApp, requireBuilt, startServerFor, type StartedServer } from "./helpers/launch.js";

/**
 * The chat panel's agent／model chips and their menus (AgentPicker.tsx) and the agent-
 * driven empty state, end to end (A1–A4). This started life as the settings
 * dialog's Agent tab test ([E3.T5] NOOP-235/#234); the dialog and the status
 * bar gear are gone — everything the author used to do there is a pill
 * under the chat box now (a chip that opens a menu), so the scenarios stay and only the selectors and
 * the "open the dialog" step changed.
 *
 * Login status is fully controlled by an injected `CommandRunner`
 * (`probe.ts`'s seam) — no real `claude`/`codex` CLI is ever consulted.
 * `editing-fake-acp-agent.mjs` (already used by e2e/freeze.test.ts and
 * friends) is reused for the one scenario (A3) that needs a real
 * text-changing session.
 *
 * Assertion style matches e2e/freeze.test.ts: vitest's plain chai-based
 * `expect`, every assertion `expect.poll(() => locator…)`.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/agent-settings-deck");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const outcome = (partial: Partial<CommandOutcome> = {}): CommandOutcome => ({ code: 0, stdout: "", stderr: "", ...partial });

/** A single fixed-adapter's `AgentAdapterConfig`, pointed at `editing-fake-acp-agent.mjs` with the real `presentationId` (Plan §3.8's launch.ts contract) and a per-kind `E2E_NEW_TITLE` so a slide edit can be attributed to whichever kind actually ran it (A3 step 5). */
function fixtureAdapterFor(kind: AgentKind, presentationId: string, newTitle: string): AgentAdapterConfig {
  return {
    kind,
    label: kind === "claude" ? "Claude Code" : "Codex",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: newTitle,
    },
  };
}

let browser: Browser;
let openPages: Page[] = [];
let activeServer: StartedServer | undefined;

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
  await activeServer?.cleanup();
  activeServer = undefined;
});

async function openPage(server: StartedServer["server"]): Promise<Page> {
  const page = await openApp(browser, server);
  openPages.push(page);
  return page;
}

/** Opens the agent chip's menu (the chip is enabled once `GET /api/agent` has answered). */
async function openAgentMenu(page: Page): Promise<void> {
  const chip = page.locator('.chat-chip[data-chip="agent"]');
  await expect.poll(() => chip.isEnabled().catch(() => false), { timeout: 10_000 }).toBe(true);
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  await expect.poll(() => page.locator('.chat-chip-menu [data-kind="claude"]').count()).toBeGreaterThan(0);
}

async function itemChecked(page: Page, kind: string): Promise<string | null> {
  return page.locator(`.chat-chip-menu [data-kind="${kind}"]`).getAttribute("aria-checked");
}

async function itemDetail(page: Page, kind: string): Promise<string | null> {
  return page.locator(`.chat-chip-menu [data-kind="${kind}"] .chat-chip-menu-detail`).textContent();
}

async function textOf(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).textContent();
}

// ─────────────────────────────────────────────────────────────────────────
// A1: 尚未登入／可用／偵測中三個場景，卡片文字與動作正確；未登入指令可複製。
// ─────────────────────────────────────────────────────────────────────────

it("A1: agent 選單依探測結果顯示使用中／未登入／偵測中，未登入那列帶登入指令", async () => {
  // An artificial pause before a probe resolves gives "偵測中…" a
  // deterministic observation window. Only re-probes are delayed (not the
  // initial mount GET) so the menu opens against already-known data.
  const PROBE_DELAY_MS = 1200;
  let probeCount = 0;
  const runner: CommandRunner = async (command) => {
    probeCount++;
    if (probeCount > 2) await new Promise((resolve) => setTimeout(resolve, PROBE_DELAY_MS));
    if (command === "claude") return outcome({ stdout: '{"loggedIn":true}' });
    if (command === "codex") return outcome({ code: 1, stdout: "Not logged in" });
    throw new Error(`unexpected probe command: ${command}`);
  };

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a1",
    initialAgent: { kind: "claude", source: "settings" },
    runCommand: runner,
    resolveAdapter: (kind, presentationId) => fixtureAdapterFor(kind, presentationId, "不會用到"),
  });

  const page = await openPage(activeServer.server);
  await openAgentMenu(page);

  // 初次載入（未延遲）：claude 使用中，codex 未登入且那列帶登入指令。
  await expect.poll(() => itemChecked(page, "claude"), { timeout: 10_000 }).toBe("true");
  expect(await itemDetail(page, "claude")).toBe("使用中");
  expect(await itemChecked(page, "codex")).toBe("false");
  expect(await itemDetail(page, "codex")).toBe("未登入 · codex login");

  // 按「重新偵測」：這次探測被延遲，「偵測中…」有確定性的觀察窗。
  const probeButton = page.locator(".chat-chip-menu-action");
  await probeButton.click();
  await expect.poll(() => probeButton.textContent()).toBe("偵測中…");
  await expect.poll(() => itemDetail(page, "codex")).toBe("偵測中…");
  await expect.poll(() => probeButton.textContent(), { timeout: 10_000 }).toBe("重新偵測登入狀態");
  expect(await itemDetail(page, "claude")).toBe("使用中");
});

// ─────────────────────────────────────────────────────────────────────────
// A2: 探針結果改變後按「重新偵測」，卡片狀態更新。
// ─────────────────────────────────────────────────────────────────────────

it("A2: 按「重新偵測」後選單裡的狀態隨探針結果更新", async () => {
  let codexLoggedIn = false;
  const runner: CommandRunner = async (command) => {
    if (command === "claude") return outcome({ stdout: '{"loggedIn":true}' });
    if (command === "codex") return codexLoggedIn ? outcome() : outcome({ code: 1, stdout: "Not logged in" });
    throw new Error(`unexpected probe command: ${command}`);
  };

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a2",
    initialAgent: { kind: "claude", source: "settings" },
    runCommand: runner,
    resolveAdapter: (kind, presentationId) => fixtureAdapterFor(kind, presentationId, "不會用到"),
  });

  const page = await openPage(activeServer.server);
  await openAgentMenu(page);

  await expect.poll(() => itemDetail(page, "codex"), { timeout: 10_000 }).toBe("未登入 · codex login");

  codexLoggedIn = true;
  await page.locator(".chat-chip-menu-action").click();

  await expect.poll(() => itemDetail(page, "codex"), { timeout: 10_000 }).toBe("可用");
});

// ─────────────────────────────────────────────────────────────────────────
// A3: 切換後聊天出現系統訊息，下一則訊息由新 agent 處理；編輯鎖中按鈕停用。
// ─────────────────────────────────────────────────────────────────────────

it("A3: 從選單切換 agent 後系統訊息、膠囊、下一則訊息與編輯鎖", async () => {
  const FREEZE_HOLD_MS = 1500;
  const bothLoggedIn: CommandRunner = async () => outcome({ stdout: '{"loggedIn":true}' });

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a3",
    initialAgent: { kind: "claude", source: "cli" },
    runCommand: bothLoggedIn,
    resolveAdapter: (kind, presentationId) => {
      const config = fixtureAdapterFor(kind, presentationId, kind === "claude" ? "Claude改的標題" : "Codex改的標題");
      return { ...config, env: { ...config.env, E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS) } };
    },
  });

  const server = activeServer.server;
  const page = await openPage(server);
  await openAgentMenu(page);

  // claude 是命令列指定的目前 agent：使用中，選單裡多一行說明來源。
  await expect.poll(() => itemChecked(page, "claude"), { timeout: 10_000 }).toBe("true");
  expect(await textOf(page, ".chat-chip-menu-hint")).toBe("本次由命令列指定");

  await page.locator('.chat-chip-menu [data-kind="codex"]').click();

  await expect.poll(() => textOf(page, ".chat-system"), { timeout: 10_000 }).toBe("已切換到 Codex，接下來的訊息由它處理");
  await expect.poll(() => textOf(page, ".agent-dot-connected")).toBe("Codex");
  // 選單選完就收起來；再打開時 codex 打勾、命令列說明消失。
  expect(await page.locator(".chat-chip-menu").count()).toBe(0);
  await openAgentMenu(page);
  await expect.poll(() => itemChecked(page, "codex")).toBe("true");
  expect(await page.locator(".chat-chip-menu-hint").count()).toBe(0);
  await page.keyboard.press("Escape");

  // `editing-fake-acp-agent.mjs` only ever answers its session's very first
  // real author prompt — one message proves both: the next message really
  // reaches the new (codex) session, AND the editing lock it takes disables
  // the menu's agent rows for the freeze window before that session's turn ends.
  await page.locator(".chat-input textarea").fill("改標題");
  await page.locator('.chat-input button[type="submit"]').click();

  async function isFrozen(): Promise<boolean> {
    const response = await page.request.get(`${server.url}/api/editing`);
    return ((await response.json()) as { frozen: boolean }).frozen;
  }
  await expect.poll(isFrozen, { timeout: 5_000 }).toBe(true);

  // 編輯鎖持有中：選單裡兩列都停用，並顯示固定提示。
  await openAgentMenu(page);
  const rows = page.locator(".chat-chip-menu [data-kind]");
  const disabledFlags = await Promise.all((await rows.all()).map((row) => row.isDisabled()));
  expect(disabledFlags.every(Boolean)).toBe(true);
  expect(await textOf(page, ".chat-chip-menu-hint")).toBe("agent 正在編輯中，切換請稍候");
  await page.keyboard.press("Escape");

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent(), { timeout: 10_000 }).toBe("Codex改的標題");
  await expect.poll(isFrozen, { timeout: 10_000 }).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────
// A4: 無 agent 時聊天面板空狀態與「開啟設定」可開對話框。
// ─────────────────────────────────────────────────────────────────────────

it("A4: 沒有 agent 時聊天面板顯示空狀態，輸入框停用，從膠囊選單可以選一個", async () => {
  const bothLoggedIn: CommandRunner = async () => outcome({ stdout: '{"loggedIn":true}' });

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a4",
    initialAgent: { kind: null, source: "none" },
    runCommand: bothLoggedIn,
    resolveAdapter: (kind, presentationId) => fixtureAdapterFor(kind, presentationId, "不會用到"),
  });

  const page = await openPage(activeServer.server);

  await expect.poll(() => page.locator(".chat-empty-state").count(), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(await textOf(page, ".chat-empty-state")).toContain("尚未選擇 agent");
  expect(await page.locator(".chat-input textarea").isDisabled()).toBe(true);
  expect(await page.locator('.chat-input button[type="submit"]').isDisabled()).toBe(true);
  await expect.poll(() => textOf(page, '.chat-chip[data-chip="agent"]'), { timeout: 10_000 }).toContain("選擇 agent");

  await openAgentMenu(page);
  expect(await itemChecked(page, "claude")).toBe("false");
  expect(await itemChecked(page, "codex")).toBe("false");
  await page.locator('.chat-chip-menu [data-kind="claude"]').click();
  await expect.poll(() => textOf(page, ".agent-dot-connected"), { timeout: 10_000 }).toBe("Claude Code");
  await expect.poll(() => page.locator(".chat-empty-state").count()).toBe(0);
});
