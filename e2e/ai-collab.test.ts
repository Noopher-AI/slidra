import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";

/**
 * [E2.T8] `05-INTERACTIONS.feature`「與 AI 協作」— the four scenarios that
 * belong in this file (plan §6.1/§6.4): 對元素留言、對整頁留言、跳轉與編
 * 輯、送出, plus AC7 (Save/Open round-trip) and AC8(b) (agent-written
 * comment shows up in the GUI without a page refresh). The fifth scenario,
 * "Agent 編輯中", is `e2e/freeze.test.ts`'s own AC-2/US46 test, extended in
 * place (§2 邊界 12 — this is the only new e2e file this ticket authorises).
 *
 * `editing-fake-acp-agent.mjs` cannot serve this file — it only knows
 * `text set`. `comment-fake-acp-agent.mjs` (this ticket's own fixture)
 * branches on the author's message text into `comment add`/`slide add`/
 * `text set`, or echoes the prompt back verbatim (the default case, which
 * is what "送出" actually asserts on: proof the comment-context prefix
 * server-side `session.ts` builds really reached the agent).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/comment-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/ai-collab-deck");
const presentationFontDir = path.join(rootDir, "packages/core/src/assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/ai-collab");

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

async function startServerFor(agentEnv: Record<string, string> = {}): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  comotPath: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-deck-"));
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
      ...agentEnv,
    },
  };

  const server = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    comotPath,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
      await rm(deckStagingDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer, options: { waitForAgent?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  if (options.waitForAgent) {
    await expect
      .poll(() => page.locator(".agent-dot").textContent().catch(() => null), { timeout: 30_000 })
      .toContain("connected");
  }
  return page;
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
  await page.locator(".chat-input input").fill(text);
  await page.locator(".chat-input button").click();
}

async function listComments(
  registry: CommandRegistry,
  id: string,
  slidePath?: string,
): Promise<{ id: string; slidePath: string; target: string; text: string }[]> {
  const result = await registry.dispatch<{ comments: { id: string; slidePath: string; target: string; text: string }[] }>(
    "comment list",
    { id, slidePath },
  );
  if (!result.ok) throw new Error(result.message);
  return result.data!.comments;
}

it("對元素留言：選取單一元素、Comment to AI、送出後選取框旁出現 comment pin（AC3 截圖）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const bar = page.locator(".context-bar");
    await expect.poll(() => bar.isVisible(), { timeout: 5000 }).toBe(true);
    await bar.getByRole("button", { name: "Comment to AI" }).click();

    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await composer.locator("textarea").fill("把這個標題改短一點");

    await settleForScreenshot(page);
    const box = await composer.boundingBox();
    if (!box) throw new Error("找不到留言框");
    await compareScreenshot(page, { name: "comment-composer", baselineDir, clip: box });

    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);

    const pin = page.locator(".comment-pin");
    await expect.poll(() => pin.textContent(), { timeout: 5000 }).toBe("1");

    const comments = await listComments(registry, presentationId, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "el-title", text: "把這個標題改短一點" })]);
  } finally {
    await cleanup();
  }
});

it("對整頁留言：縮圖留言鈕開整頁留言框，送出後縮圖恆亮紅底", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBeGreaterThan(0);

    const commentButton = page.locator('.overview-item[data-index="0"] .overview-comment-button');
    await commentButton.dispatchEvent("click"); // 滑入才顯示（opacity 0），直接觸發 click 事件不需要真的 hover。

    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await composer.locator("textarea").fill("整頁重寫成三個要點");
    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);

    await expect.poll(() => commentButton.evaluate((el) => el.classList.contains("has-comments")), { timeout: 5000 }).toBe(true);

    const comments = await listComments(registry, presentationId, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "page", text: "整頁重寫成三個要點" })]);
  } finally {
    await cleanup();
  }
});

it("跳轉與編輯：點 Pinned context 的一列、或點 comment pin，開啟編輯模式（原文帶入、Save changes）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/001.svg", target: "el-title", text: "元素留言" });
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/002.svg", target: "page", text: "整頁留言" });

    const page = await openApp(server);
    const pinnedItems = page.locator(".chat-pinned-item");
    await expect.poll(() => pinnedItems.count(), { timeout: 5000 }).toBe(2);

    // 第一列（頁序在前）：點擊跳到該頁、選取該元素、開編輯模式。
    await pinnedItems.nth(0).locator(".chat-pinned-item-text").click();
    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => composer.locator("textarea").inputValue(), { timeout: 5000 }).toBe("元素留言");
    expect(await composer.getByRole("button", { name: "Save changes" }).isVisible()).toBe(true);
    await composer.getByRole("button", { name: "Cancel" }).click();

    // comment pin：與上面同一則留言，點擊同樣開編輯模式。
    const pin = page.locator(".comment-pin");
    await expect.poll(() => pin.isVisible(), { timeout: 5000 }).toBe(true);
    await pin.click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => composer.locator("textarea").inputValue(), { timeout: 5000 }).toBe("元素留言");
    await composer.getByRole("button", { name: "Cancel" }).click();

    // 第二列（整頁留言）：跳頁、清空選取、開編輯模式。
    await pinnedItems.nth(1).locator(".chat-pinned-item-text").click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => composer.locator("textarea").inputValue(), { timeout: 5000 }).toBe("整頁留言");
  } finally {
    await cleanup();
  }
});

it("送出：留言隨訊息一起送給 agent（context 前綴真的抵達）；Pinned context 截圖（AC4）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/001.svg", target: "el-title", text: "把標題改短" });
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/002.svg", target: "page", text: "整頁重寫" });

    const page = await openApp(server, { waitForAgent: true });
    const pinned = page.locator(".chat-pinned");
    await expect.poll(() => pinned.isVisible(), { timeout: 5000 }).toBe(true);
    expect(await page.locator(".chat-input-pinned").textContent()).toBe("2 pinned");

    await settleForScreenshot(page);
    const box = await pinned.boundingBox();
    if (!box) throw new Error("找不到 Pinned context");
    await compareScreenshot(page, { name: "pinned-context", baselineDir, clip: box });

    await sendChatMessage(page, "麻煩照留言處理");
    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("麻煩照留言處理");
    const replyText = (await reply.textContent()) ?? "";
    expect(replyText).toContain("slides/001.svg el-title");
    expect(replyText).toContain("把標題改短");
    expect(replyText).toContain("slides/002.svg page");
    expect(replyText).toContain("整頁重寫");
  } finally {
    await cleanup();
  }
});

it("Agent 編輯中（持鎖）：titlebar 凍結徽章截圖（AC5）", async () => {
  const FREEZE_HOLD_MS = 1500;
  const { server, cleanup } = await startServerFor({ E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS) });
  try {
    const page = await openApp(server, { waitForAgent: true });
    await sendChatMessage(page, "持鎖");

    const badge = page.locator(".titlebar-frozen-badge");
    await expect.poll(() => badge.isVisible(), { timeout: 30_000 }).toBe(true);

    await settleForScreenshot(page);
    const box = await page.locator(".titlebar").boundingBox();
    if (!box) throw new Error("找不到 titlebar");
    await compareScreenshot(page, { name: "titlebar-frozen", baselineDir, clip: box });
  } finally {
    await cleanup();
  }
});

it("從大綱草擬：Running 指令卡截圖（AC6）", async () => {
  const DRAFT_HOLD_MS = 1500;
  const { server, cleanup } = await startServerFor({ E2E_DRAFT_HOLD_MS: String(DRAFT_HOLD_MS) });
  try {
    const page = await openApp(server, { waitForAgent: true });
    await sendChatMessage(
      page,
      "【從大綱草擬新頁】請依下面的大綱，用 co-motion slide add 在第 1 頁（slides/001.svg）之後依序插入新頁，每一行大綱一頁；縮排的行是上一行那一頁的副標。插入後請用 textbox add 把文字放進新頁。\n\n第一步\n第二步",
    );

    const commandCard = page.locator(".chat-command-in_progress");
    await expect.poll(() => commandCard.isVisible(), { timeout: 30_000 }).toBe(true);

    await settleForScreenshot(page);
    const box = await commandCard.boundingBox();
    if (!box) throw new Error("找不到 Running 指令卡");
    await compareScreenshot(page, { name: "running-command-card", baselineDir, clip: box });
  } finally {
    await cleanup();
  }
});

it("AC7：留言經 Save／Open 往返後仍在", async () => {
  const { server, registry, comotPath, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await page.locator(".context-bar").getByRole("button", { name: "Comment to AI" }).click();
    const composer = page.locator(".comment-composer");
    await composer.locator("textarea").fill("存檔後應該還在");
    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);

    await page.locator('.titlebar-button[title="Save (⌘S)"]').click();
    await expect.poll(() => page.locator(".titlebar-saved-status").textContent(), { timeout: 30_000 }).toBe("Saved");
    // A short settle after the "Saved" status text appears — observed
    // flaky without it (re-open sometimes raced the save's own disk write
    // finishing), matching the same "DOM update precedes full settle"
    // reasoning helpers/screenshot.ts's settleForScreenshot documents.
    await page.waitForTimeout(500);

    const reopened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const comments = await listComments(registry, reopened.data!.id, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "el-title", text: "存檔後應該還在" })]);
  } finally {
    await cleanup();
  }
});

it("AC8(b)：agent 用 comment 命令寫入後，不重新整理，GUI 的 Pinned context 自動多一列", async () => {
  const AGENT_COMMENT = "agent 透過命令寫的留言";
  const { server, cleanup } = await startServerFor({ E2E_AGENT_COMMENT: AGENT_COMMENT });
  try {
    const page = await openApp(server, { waitForAgent: true });
    expect(await page.locator(".chat-pinned").count()).toBe(0);

    await sendChatMessage(page, "寫留言");

    const pinnedItems = page.locator(".chat-pinned-item");
    await expect.poll(() => pinnedItems.count(), { timeout: 30_000 }).toBe(1);
    expect(await pinnedItems.first().textContent()).toContain(AGENT_COMMENT);
  } finally {
    await cleanup();
  }
});
