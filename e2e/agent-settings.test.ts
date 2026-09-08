import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import type { AgentKind } from "../packages/server/src/agent/adapters.js";
import type { CommandOutcome, CommandRunner } from "../packages/server/src/agent/probe.js";
import { openApp, requireBuilt, startServerFor, type StartedServer } from "./helpers/launch.js";

/**
 * [E3.T5] NOOP-235/#234 — the settings dialog's Agent tab and the chat
 * panel's agent-driven empty state, end to end (A1–A4, Plan §5). The only
 * new e2e file this ticket opens (D9): every scenario needs
 * `initialAgent`/`agentManager.{runCommand,resolveAdapter}` (Plan §3.8),
 * a server construction shape no existing e2e file uses, and folding it
 * into `ai-collab.test.ts`'s own `startServerFor` would force that shared
 * helper to grow a second, incompatible mode.
 *
 * Login status is fully controlled by an injected `CommandRunner`
 * (`probe.ts`'s seam) — no real `claude`/`codex` CLI is ever consulted.
 * `editing-fake-acp-agent.mjs` (already used by e2e/freeze.test.ts and
 * friends) is reused for the one scenario (A3) that needs a real
 * text-changing session, since a real agent needing to run a real
 * `co-motion` command is exactly why `agentEnv`/`resolveAdapter` must be
 * able to name a real `presentationId` before the session is built.
 *
 * Assertion style matches e2e/freeze.test.ts, not `@playwright/test`'s own
 * `expect(locator).toBeVisible()` family — this suite runs on vitest's
 * plain chai-based `expect`, which has no such matchers; every assertion
 * below is `expect.poll(() => locator.textContent()/.isVisible()/...)`.
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

async function openSettingsDialog(page: Page): Promise<void> {
  await page.locator(".titlebar-settings-button").click();
  await expect.poll(() => page.locator('[role="dialog"][aria-label="Settings"]').isVisible()).toBe(true);
}

async function textOf(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).textContent();
}

// ─────────────────────────────────────────────────────────────────────────
// A1: 尚未登入／可用／偵測中三個場景，卡片文字與動作正確；未登入指令可複製。
// ─────────────────────────────────────────────────────────────────────────

it("A1: 對話框裡卡片依探測結果顯示尚未登入／可用／偵測中，未登入指令可複製", async () => {
  // Plan §3.8: an artificial pause before a probe resolves gives "偵測
  // 中…" a deterministic observation window. Only re-probes are delayed
  // here (not the initial mount GET) so the dialog opens against already-
  // known card data — AgentTab's "偵測中" row (Plan §4.4 row 1) explicitly
  // renders on top of "依上一次已知結果顯示", which the very first load has
  // none of yet (noted in this PR's own "不確定與保留事項").
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

  const server = activeServer.server;
  const page = await openPage(server);
  await openSettingsDialog(page);

  // 初次載入（未延遲）：claude 可用且使用中，codex 尚未登入且登入指令逐字正確。
  await expect.poll(() => textOf(page, '[data-kind="claude"] .agent-card-status'), { timeout: 10_000 }).toBe("可用");
  expect(await textOf(page, '[data-kind="claude"] .agent-card-in-use-badge')).toBe("使用中");
  expect(await textOf(page, '[data-kind="codex"] .agent-card-status')).toBe("尚未登入");
  expect(await textOf(page, '[data-kind="codex"] .agent-card-login-command')).toBe("codex login");

  // 按「重新偵測」：這次探測被延遲，「偵測中…」有確定性的觀察窗。
  await page.locator(".agent-tab-probe-button").click();
  await expect.poll(() => textOf(page, '[data-kind="codex"] .agent-card-status')).toBe("偵測中…");
  expect(await textOf(page, '[data-kind="claude"] .agent-card-status')).toBe("偵測中…");
  await expect.poll(() => textOf(page, '[data-kind="claude"] .agent-card-status'), { timeout: 10_000 }).toBe("可用");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
  await page.locator('[data-kind="codex"] .agent-card-copy-button').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("codex login");
});

// ─────────────────────────────────────────────────────────────────────────
// A2: 探針結果改變後按「重新偵測」，卡片狀態更新。
// ─────────────────────────────────────────────────────────────────────────

it("A2: 按「重新偵測」後卡片狀態隨探針結果更新", async () => {
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
  await openSettingsDialog(page);

  await expect.poll(() => textOf(page, '[data-kind="codex"] .agent-card-status'), { timeout: 10_000 }).toBe("尚未登入");
  expect(await page.locator('[data-kind="codex"] .agent-card-use-button').count()).toBe(0);

  codexLoggedIn = true;
  await page.locator(".agent-tab-probe-button").click();

  await expect.poll(() => textOf(page, '[data-kind="codex"] .agent-card-status'), { timeout: 10_000 }).toBe("可用");
  expect(await textOf(page, '[data-kind="codex"] .agent-card-use-button')).toBe("使用這個");
});

// ─────────────────────────────────────────────────────────────────────────
// A3: 切換後聊天出現系統訊息，下一則訊息由新 agent 處理；編輯鎖中按鈕停用。
// ─────────────────────────────────────────────────────────────────────────

it("A3: 切換 agent 後系統訊息、標題列、下一則訊息與編輯鎖", async () => {
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
  await openSettingsDialog(page);

  // claude 是命令列指定的目前 agent：使用中 + 本次由命令列指定。
  await expect.poll(() => textOf(page, '[data-kind="claude"] .agent-card-in-use-badge'), { timeout: 10_000 }).toBe("使用中");
  expect(await textOf(page, '[data-kind="claude"] .agent-card-cli-badge')).toBe("本次由命令列指定");

  await page.locator('[data-kind="codex"] .agent-card-use-button').click();

  await expect.poll(() => textOf(page, ".chat-system"), { timeout: 10_000 }).toBe("已切換到 Codex，接下來的訊息由它處理");
  await expect.poll(() => textOf(page, ".agent-dot-connected")).toBe("Codex");
  // source 已變回 settings：命令列標記消失。
  await expect.poll(() => page.locator(".agent-card-cli-badge").count()).toBe(0);

  await page.locator(".settings-dialog-close").click();
  await expect.poll(() => page.locator('[role="dialog"][aria-label="Settings"]').count()).toBe(0);

  // `editing-fake-acp-agent.mjs` only ever answers its session's very first
  // real author prompt (see its own header comment) — one message proves
  // both A3 assertions: the next message really reaches the new (codex)
  // session, AND the editing lock it takes disables the settings dialog's
  // switch buttons for the freeze window before that session's turn ends.
  await page.locator(".chat-input input").fill("改標題");
  await page.locator('.chat-input button[type="submit"]').click();

  async function isFrozen(): Promise<boolean> {
    const response = await page.request.get(`${server.url}/api/editing`);
    return ((await response.json()) as { frozen: boolean }).frozen;
  }
  await expect.poll(isFrozen, { timeout: 5_000 }).toBe(true);

  // 編輯鎖持有中：開設定，兩張卡的「使用這個」都停用，並顯示固定提示。
  await openSettingsDialog(page);
  const useButtons = page.locator(".agent-card-use-button");
  const disabledFlags = await Promise.all((await useButtons.all()).map((button) => button.isDisabled()));
  expect(disabledFlags.every(Boolean)).toBe(true);
  expect(await textOf(page, ".agent-card-frozen-hint")).toBe("agent 正在編輯中，請稍候");
  await page.locator(".settings-dialog-close").click();

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent(), { timeout: 10_000 }).toBe("Codex改的標題");
  await expect.poll(isFrozen, { timeout: 10_000 }).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────
// A4: 無 agent 時聊天面板空狀態與「開啟設定」可開對話框。
// ─────────────────────────────────────────────────────────────────────────

it("A4: 沒有 agent 時聊天面板顯示空狀態，輸入框停用，開啟設定可開對話框", async () => {
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
  expect(await page.locator(".chat-input input").isDisabled()).toBe(true);
  expect(await page.locator('.chat-input button[type="submit"]').isDisabled()).toBe(true);

  await page.locator(".chat-empty-state-button").click();
  await expect.poll(() => page.locator('[role="dialog"][aria-label="Settings"]').isVisible()).toBe(true);
});
