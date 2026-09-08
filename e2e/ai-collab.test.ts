import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot, settleForScreenshot, settledBox, type Box } from "./helpers/screenshot.js";

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

/**
 * 把 boundingBox 取整並夾在 viewport 內——尺寸不符是 compareScreenshot 的無容忍硬失敗
 * （helpers/screenshot.ts）。角落各自四捨五入（而不是 x/y 與 width/height 分開四捨五入）
 * 是刻意的：後者在 box 邊界落在 .5 附近時，x 與 width 可能各自進位到不同方向，兩次執行
 * 算出的尺寸就會差 1px。從角落算可以消掉這個誤差（抄自 e2e/table.test.ts 的 snapClip）。
 */
function snapClip(box: Box): Box {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const right = Math.min(VIEWPORT.width, Math.round(box.x + box.width));
  const bottom = Math.min(VIEWPORT.height, Math.round(box.y + box.height));
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) throw new Error(`clip 尺寸無效：${width}x${height}`);
  return { x, y, width, height };
}

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

async function startServerFor(
  agentEnv: Record<string, string> = {},
  skills: { bundled?: Record<string, string>; user?: Record<string, string> } = {},
): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  comotPath: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-deck-"));
  // [E3.T3] #232/#236: never resolve against the real machine's
  // `~/.claude/skills` — a real skill directory happening to exist on
  // whatever machine runs this suite would silently leak into `/` list
  // assertions (Plan §6.3). Always temp dirs, populated per-test via
  // `skills.bundled`/`skills.user` (SKILL.md frontmatter text, keyed by
  // skill directory name) when a test needs a deterministic entry.
  const bundledSkillsDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-bundled-"));
  const userSkillsDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-ai-collab-user-"));
  for (const [dir, entries] of [
    [bundledSkillsDir, skills.bundled] as const,
    [userSkillsDir, skills.user] as const,
  ]) {
    for (const [name, frontmatter] of Object.entries(entries ?? {})) {
      const skillDir = path.join(dir, name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), frontmatter, "utf8");
    }
  }
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

  const server = await startServe({
    registry,
    presentationId,
    port: 0,
    agent,
    skillDirs: { bundled: bundledSkillsDir, user: userSkillsDir },
  });

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
      await rm(bundledSkillsDir, { recursive: true, force: true });
      await rm(userSkillsDir, { recursive: true, force: true });
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
    // TitleBar.tsx shows the connected agent's own label ("Claude Code"),
    // not the literal word "connected", once it is live — the stable,
    // connection-state-derived signal is the `agent-dot-connected` class
    // (`agent-dot agent-dot-${agentConnection}`), never the text content.
    await page.locator(".agent-dot.agent-dot-connected").waitFor({ timeout: 30_000 });
    expect(await page.locator(".agent-dot").textContent()).toBe("Claude Code");
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
    const box = snapClip(await settledBox(composer, "留言框"));
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

it("⌘↵ 儲存留言（06-KEYBOARD_AND_GESTURES.md）：在留言框按 ⌘Enter 等同按 Add comment", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const bar = page.locator(".context-bar");
    await expect.poll(() => bar.isVisible(), { timeout: 5000 }).toBe(true);
    await bar.getByRole("button", { name: "Comment to AI" }).click();

    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await composer.locator("textarea").fill("⌘Enter 儲存留言測試");
    await composer.locator("textarea").press("Meta+Enter");

    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);
    const pin = page.locator(".comment-pin");
    await expect.poll(() => pin.textContent(), { timeout: 5000 }).toBe("1");

    const comments = await listComments(registry, presentationId, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "el-title", text: "⌘Enter 儲存留言測試" })]);
  } finally {
    await cleanup();
  }
});

it("⌘↵ 送出聊天（06-KEYBOARD_AND_GESTURES.md）：在聊天輸入框按 ⌘Enter 等同按 Send", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { waitForAgent: true });
    await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
    const input = page.locator(".chat-input input");
    await input.fill("⌘Enter 送出測試");
    await input.press("Meta+Enter");

    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("⌘Enter 送出測試");
    expect(await input.inputValue()).toBe(""); // 送出後清空輸入框
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
    const box = snapClip(await settledBox(pinned, "Pinned context"));
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
    const box = snapClip(await settledBox(page.locator(".titlebar"), "titlebar"));
    await compareScreenshot(page, { name: "titlebar-frozen", baselineDir, clip: box });
  } finally {
    await cleanup();
  }
});

it("從大綱草擬：走真實 UI 入口，agent 真的插入新頁（AC2）＋ Running 指令卡截圖（AC6）", async () => {
  const DRAFT_HOLD_MS = 1500;
  const { server, registry, presentationId, cleanup } = await startServerFor({
    E2E_DRAFT_HOLD_MS: String(DRAFT_HOLD_MS),
  });
  try {
    const page = await openApp(server, { waitForAgent: true });
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBe(2);

    await page.getByRole("button", { name: "New" }).click();
    const menu = page.locator('[data-menu="new"]');
    await menu.getByRole("menuitem", { name: "From outline…" }).click();
    await page.locator(".outline-modal-textarea").fill("第一步\n第二步");
    await page.locator(".outline-modal-submit").click();

    const commandCard = page.locator(".chat-command-in_progress");
    await expect.poll(() => commandCard.isVisible(), { timeout: 30_000 }).toBe(true);

    // `co-motion slide add <presentationId> --at 1` 裡的 presentationId 是
    // generateOpaqueId() 產生的隨機 12 字元，每次 open 都不同，會讓截圖逐像素
    // 比對不穩定（計畫 §4.3）。截圖前先斷言真的顯示的是這條指令，再換成等長
    // 固定佔位字串（等寬字，寬度不變），最後斷言替換確實生效。
    const commandText = commandCard.locator(".chat-command-text");
    expect(await commandText.textContent()).toBe(`co-motion slide add ${presentationId} --at 1`);
    const placeholderId = "e2eFixedId00";
    expect(placeholderId).toHaveLength(12);
    expect(presentationId).toHaveLength(12);
    await commandText.evaluate((el, ph) => {
      el.textContent = el.textContent!.replace(ph.real, ph.placeholder);
    }, { real: presentationId, placeholder: placeholderId });
    expect(await commandText.textContent()).toBe(`co-motion slide add ${placeholderId} --at 1`);

    await settleForScreenshot(page);
    const box = snapClip(await settledBox(commandCard, "Running 指令卡"));
    await compareScreenshot(page, { name: "running-command-card", baselineDir, clip: box });

    // AC2：新頁真的被插入，不只是 UI 事件——縮圖列 +1、project.json 的
    // slides 在原索引 +1 的位置多一個新路徑（[Fix.5]）。
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBe(3);
    const project = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "project.json" });
    const slides = (JSON.parse(project.data!.content).slides as string[]);
    expect(slides).toHaveLength(3);
    expect(slides[0]).toBe("slides/001.svg");
    expect(slides[2]).toBe("slides/002.svg");
    expect(slides[1]).not.toBe("slides/001.svg");
    expect(slides[1]).not.toBe("slides/002.svg");
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

// [E3.T3] #232/#236: the `/` slash-command menu. Not a new e2e file (Plan
// §6.2/§7 — no new e2e file this ticket authorises) — this suite already
// starts a real server+browser with a fake agent that can echo prompts
// verbatim, exactly what these two scenarios need.

it("斜線命令：清單、↑↓ 選取、Enter 補全、Esc 關閉、回報更新即時變動", async () => {
  const { server, cleanup } = await startServerFor({
    E2E_AVAILABLE_COMMANDS: JSON.stringify([
      { name: "draft", description: "草擬一頁新投影片" },
      { name: "publish", description: "發布目前版本" },
    ]),
    E2E_AVAILABLE_COMMANDS_UPDATE: JSON.stringify([
      { name: "draft", description: "草擬一頁新投影片" },
      { name: "archive", description: "封存目前簡報" },
    ]),
  });
  try {
    const page = await openApp(server, { waitForAgent: true });
    const input = page.locator(".chat-input input");
    const menu = page.locator(".slash-menu");
    const menuItem = page.locator(".slash-menu-item");

    // Before any message is sent, the agent hasn't reported anything yet
    // (session.ts: the ACP subprocess is spawned lazily on the first chat
    // message) — sending one first is what actually makes its
    // availableCommands report land.
    await sendChatMessage(page, "打個招呼");
    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("打個招呼");

    // 清單全部出現，含描述（AC1 的畫面驗證部分）。
    await input.fill("/");
    await expect.poll(() => menuItem.count(), { timeout: 5000 }).toBe(2);
    expect(await menuItem.nth(0).textContent()).toContain("draft");
    expect(await menuItem.nth(0).textContent()).toContain("草擬一頁新投影片");
    expect(await menuItem.nth(1).textContent()).toContain("publish");

    // ↓↓ 從 draft 選到 publish，再繞回 draft，Enter 補全成 "/draft "。
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await expect.poll(() => menuItem.nth(0).getAttribute("aria-selected"), { timeout: 5000 }).toBe("true");
    await input.press("Enter");
    await expect.poll(() => input.inputValue(), { timeout: 5000 }).toBe("/draft ");
    await expect.poll(() => menu.count(), { timeout: 5000 }).toBe(0); // 補全後 draft 不再符合觸發條件，選單自動關閉

    // Esc：重新打開後關閉，且在同一個觸發區段內繼續打字不重開。
    await input.fill("/");
    await expect.poll(() => menuItem.count(), { timeout: 5000 }).toBe(2);
    await input.press("Escape");
    await expect.poll(() => menu.count(), { timeout: 5000 }).toBe(0);
    await input.press("d"); // 仍在觸發條件內（"/d"），但 Esc 關閉狀態必須持續
    await expect.poll(() => menu.count(), { timeout: 5000 }).toBe(0);
    await input.fill(""); // 離開觸發條件，Esc 的關閉狀態重置
    await input.fill("/");
    await expect.poll(() => menuItem.count(), { timeout: 5000 }).toBe(2); // 重新打開

    // 回報更新後，不重新整理頁面，清單即時變動：publish 消失、archive 出現。
    // （這則訊息本身不觸發任何 agent 回覆——假 agent 送出更新後直接
    // end_turn，見 comment-fake-acp-agent.mjs 的「更新命令」分支——所以這裡
    // 直接輪詢選單內容，而不是等待一則不存在的新訊息。）
    await input.fill("");
    await sendChatMessage(page, "更新命令");
    await expect.poll(() => input.inputValue(), { timeout: 5000 }).toBe(""); // sendMessage() 清空 draft 後才輪到這裡打 "/"
    await input.fill("/");
    await expect.poll(() => menuItem.allTextContents(), { timeout: 30_000 }).toEqual(
      expect.arrayContaining([expect.stringContaining("archive")]),
    );
    const namesAfterUpdate = (await menuItem.allTextContents()).join(" ");
    expect(namesAfterUpdate).toContain("draft");
    expect(namesAfterUpdate).toContain("archive");
    expect(namesAfterUpdate).not.toContain("publish");
  } finally {
    await cleanup();
  }
});

it("斜線命令：送出 /xxx 參數 時，假 agent 收到的 prompt 文字與輸入完全相同", async () => {
  const { server, cleanup } = await startServerFor(
    {},
    { bundled: { outline: "---\nname: outline\ndescription: 從大綱建立投影片\n---\n" } },
  );
  try {
    const page = await openApp(server, { waitForAgent: true });
    const input = page.locator(".chat-input input");

    // "outline" comes from the bundled skill directory, which is populated
    // before the server ever starts — no need to wait for the agent's own
    // report (which does not exist yet, see the test above) to complete
    // this one. commands.ts's `collectSlashCommands` namespaces every
    // bundled skill with `BUNDLED_PREFIX` ("comotion-") before the `/`
    // list ever reaches the client, precisely so an author can tell a
    // CoMotion-shipped skill apart from an agent-reported or user one — so
    // the bundled "outline" skill is exposed (and must be typed) as
    // "comotion-outline", never bare "outline".
    await input.fill("/comotion-out");
    await expect.poll(() => page.locator(".slash-menu-item").count(), { timeout: 5000 }).toBe(1);
    await input.press("Enter");
    const completed = await input.inputValue();
    expect(completed).toBe("/comotion-outline ");

    // 繼續打參數——補全後的文字原封不動，只是後面接著使用者自己打的字。
    await input.fill(`${completed}這是參數`);
    await expect.poll(() => page.locator(".slash-menu").count(), { timeout: 5000 }).toBe(0); // 含空白，觸發條件已不成立
    await page.locator(".chat-input button:not([disabled])").click();

    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toBe("/comotion-outline 這是參數");
  } finally {
    await cleanup();
  }
});
