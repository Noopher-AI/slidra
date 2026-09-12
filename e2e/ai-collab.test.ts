import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { waitForAgentConnected } from "./helpers/launch.js";

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
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/comment-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/ai-collab-deck");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");
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
  slidraPath: string;
  cleanup: () => Promise<void>;
}> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-deck-"));
  // [E3.T3] #232/#236: never resolve against the real machine's
  // `~/.claude/skills` — a real skill directory happening to exist on
  // whatever machine runs this suite would silently leak into `/` list
  // assertions (Plan §6.3). Always temp dirs, populated per-test via
  // `skills.bundled`/`skills.user` (SKILL.md frontmatter text, keyed by
  // skill directory name) when a test needs a deterministic entry.
  const bundledSkillsDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-bundled-"));
  const userSkillsDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-user-"));
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
  process.env.SLIDRA_HOME = slidraHome;
  // [E4.T9]/F7: slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  await cp(deckDir, deckStagingDir, { recursive: true });
  await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
  await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckStagingDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
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

  const server = await startServe({ presentationId,
    port: 0,
    agent,
    skillDirs: { bundled: bundledSkillsDir, user: userSkillsDir },
  });

  return {
    server,
    registry,
    presentationId,
    slidraPath,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
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
    await waitForAgentConnected(page);
  }
  return page;
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
  await page.locator(".chat-input textarea").fill(text);
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

/** [E5.T7]/F-17 決定 8: the context bar is ghost (`pointer-events: none`) until the pointer hovers it long enough to solidify — a click before this never reaches a button, it always resolves to the iframe underneath instead. */
async function hoverContextBar(page: Page): Promise<void> {
  const box = (await page.locator(".context-bar").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
}

it("對元素留言：選取單一元素、Comment to AI、送出後選取框旁出現 comment pin", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const bar = page.locator(".context-bar");
    await expect.poll(() => bar.isVisible(), { timeout: 5000 }).toBe(true);
    await hoverContextBar(page);
    await bar.getByRole("button", { name: "Comment to AI" }).click();

    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await composer.locator("textarea").fill("把這個標題改短一點");

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
    await hoverContextBar(page);
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
    const input = page.locator(".chat-input textarea");
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

it("送出：留言隨訊息一起送給 agent（context 前綴真的抵達）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/001.svg", target: "el-title", text: "把標題改短" });
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/002.svg", target: "page", text: "整頁重寫" });

    const page = await openApp(server, { waitForAgent: true });
    const pinned = page.locator(".chat-pinned");
    await expect.poll(() => pinned.isVisible(), { timeout: 5000 }).toBe(true);
    expect(await page.locator(".chat-input-pinned").textContent()).toBe("2 pinned");

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

it("送出：有釘選留言時，輸入框留空也送得出去（留言本身就是要求）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/001.svg", target: "el-title", text: "把標題改短" });

    const page = await openApp(server, { waitForAgent: true });
    await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
    await page.locator(".chat-input button").click(); // 一個字都沒打

    // 對話裡顯示的是佔位字，不是空泡泡。
    const authored = page.locator(".chat-message-author").last();
    await expect.poll(() => authored.textContent(), { timeout: 5000 }).toBe("（未輸入訊息，只送出 1 則釘選留言）");

    // 假 agent 回聲收到的 prompt：留言與「沒有輸入訊息」的指示都在，沒有空的【作者的訊息】。
    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("把標題改短");
    const replyText = (await reply.textContent()) ?? "";
    expect(replyText).toContain("作者沒有輸入訊息");
    expect(replyText).not.toContain("【作者的訊息】");
  } finally {
    await cleanup();
  }
});

it("Agent 編輯中（持鎖）：titlebar 出現凍結徽章", async () => {
  const FREEZE_HOLD_MS = 1500;
  const { server, cleanup } = await startServerFor({ E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS) });
  try {
    const page = await openApp(server, { waitForAgent: true });
    await sendChatMessage(page, "持鎖");

    const badge = page.locator(".titlebar-frozen-badge");
    await expect.poll(() => badge.isVisible(), { timeout: 30_000 }).toBe(true);
  } finally {
    await cleanup();
  }
});

it("#303：送出後 Send 鈕變成停止鍵，按下去這一輪以 cancelled 結束並顯示「已停止」", async () => {
  // The 持鎖 branch holds for E2E_FREEZE_HOLD_MS before running its
  // command — the observable window in which Stop has something to stop.
  const { server, registry, presentationId, cleanup } = await startServerFor({ E2E_FREEZE_HOLD_MS: "8000" });
  try {
    const page = await openApp(server, { waitForAgent: true });
    const before = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
    await sendChatMessage(page, "持鎖");

    const stop = page.locator(".chat-input .chat-stop");
    await expect.poll(() => stop.isVisible(), { timeout: 10_000 }).toBe(true);
    await stop.click();

    const stopped = page.locator(".chat-system", { hasText: "已停止" });
    await expect.poll(() => stopped.count(), { timeout: 10_000 }).toBe(1);
    // Send is back, the turn is over, and the held command never ran.
    await expect.poll(() => page.locator(".chat-input button[type=submit]").isVisible(), { timeout: 5000 }).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
    expect(after.data!.content).toBe(before.data!.content);
  } finally {
    await cleanup();
  }
});

/**
 * #303: `From outline…` now goes 大綱 → `/slidra-plan` → `plan set`（假 agent）
 * → 計畫閘門（`.plan-gate`，擋住式）→ 確認並建置 → `/slidra-build 【計畫確認】`
 * → `slide add`（假 agent）。Running 指令卡的截圖（舊 AC6）不再在這裡驗：這條
 * 路的第一條命令是一整份 `plan set '…'`，卡片文字與舊基準 `running-command-card`
 * 完全不同；那張基準隨這次改動作廢。
 */
async function openOutlineAndSubmit(page: Page, outline: string): Promise<void> {
  await page.getByRole("button", { name: "New" }).click();
  const menu = page.locator('[data-menu="new"]');
  await menu.getByRole("menuitem", { name: "From outline…" }).click();
  await page.locator(".outline-modal-textarea").fill(outline);
  await page.locator(".outline-modal-submit").click();
}

it("從大綱規劃：走真實 UI 入口，計畫閘門彈出、建議選項預選，確認後 agent 真的建置新頁（AC2）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { waitForAgent: true });
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBe(2);

    await openOutlineAndSubmit(page, "第一步\n第二步");

    // 送出的是 /slidra-plan 加固定位置行（契約 §4），不是舊的 slide add 前綴。
    const authored = page.locator(".chat-message-author").last();
    await expect.poll(() => authored.textContent(), { timeout: 5000 }).toContain("/slidra-plan 【從大綱規劃】目前有 2 頁，新頁接在最後。");

    // 假 agent 的 `plan set` 落地 → live reload → 閘門開；不用重新整理。
    const gate = page.locator(".plan-gate");
    await expect.poll(() => gate.isVisible(), { timeout: 30_000 }).toBe(true);
    // 計畫表與題目都來自檔案；agent 的建議是預設值。
    expect(await gate.locator(".plan-gate-table tbody tr").count()).toBe(1);
    expect(await gate.locator(".plan-gate-table tbody td").nth(1).textContent()).toBe("封面");
    const recommended = gate.locator('.plan-gate-question[data-question-id="mode"] input[value="pyramid"]');
    expect(await recommended.isChecked()).toBe(true);
    expect(await gate.locator(".plan-gate-recommended").count()).toBe(1);

    // 擋住式：Esc 關不掉。
    await page.keyboard.press("Escape");
    expect(await gate.isVisible()).toBe(true);

    // 換一個選項、填補充，確認並建置 → 送出的訊息一行一題（契約 §4）。
    await gate.locator('.plan-gate-question[data-question-id="mode"] input[value="narrative"]').check();
    await gate.locator(".plan-gate-free-text input").fill("用故事線");
    await gate.locator(".plan-gate-overall textarea").fill("整體再精簡");
    await gate.locator(".plan-gate-confirm").click();
    await expect.poll(() => gate.count(), { timeout: 5000 }).toBe(0);
    const confirmMessage = page.locator(".chat-message-author").last();
    await expect.poll(() => confirmMessage.textContent(), { timeout: 5000 }).toContain("/slidra-build 【計畫確認】");
    expect(await confirmMessage.textContent()).toContain("mode=narrative");
    expect(await confirmMessage.textContent()).toContain("mode.note=用故事線");
    expect(await confirmMessage.textContent()).toContain("補充：整體再精簡");

    // AC2：新頁真的被加上，不只是 UI 事件——縮圖列 +1、project.json 多一個路徑。
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBe(3);
    const project = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "project.json" });
    const slides = JSON.parse(project.data!.content).slides as string[];
    expect(slides).toHaveLength(3);
    // 同一份草稿不會在後續 presentation-changed 時再彈一次（agent 還沒把它改成 confirmed）。
    expect(await gate.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("從大綱規劃：閘門的「放棄」直接刪掉 plan/，閘門消失、agent 不介入", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { waitForAgent: true });
    await openOutlineAndSubmit(page, "只有一行");
    const gate = page.locator(".plan-gate");
    await expect.poll(() => gate.isVisible(), { timeout: 30_000 }).toBe(true);

    await gate.locator(".plan-gate-discard").click();
    await expect.poll(() => gate.count(), { timeout: 10_000 }).toBe(0);

    const outlineFile = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "plan/outline.md" });
    expect(outlineFile.ok).toBe(false);
    // 沒有送任何聊天訊息：最後一則作者訊息仍是原本的 /slidra-plan。
    const authored = page.locator(".chat-message-author").last();
    expect(await authored.textContent()).toContain("/slidra-plan");
    expect(await page.locator(".overview-item").count()).toBe(2);
  } finally {
    await cleanup();
  }
});

it("AC7：留言經 Save／Open 往返後仍在", async () => {
  const { server, registry, slidraPath, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await hoverContextBar(page);
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

    const reopened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
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
    const input = page.locator(".chat-input textarea");
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
    { bundled: { "slidra-plan": "---\nname: slidra-plan\ndescription: 從大綱規劃投影片\n---\n" } },
  );
  try {
    const page = await openApp(server, { waitForAgent: true });
    const input = page.locator(".chat-input textarea");

    // "slidra-plan" comes from the bundled skill directory, which is
    // populated before the server ever starts — no need to wait for the
    // agent's own report (which does not exist yet, see the test above) to
    // complete this one. A shipped skill's directory name carries the
    // `slidra-` namespace itself, so what the author types is exactly
    // what the agent has registered (#248).
    await input.fill("/slidra-pl");
    await expect.poll(() => page.locator(".slash-menu-item").count(), { timeout: 5000 }).toBe(1);
    await input.press("Enter");
    const completed = await input.inputValue();
    expect(completed).toBe("/slidra-plan ");

    // 繼續打參數——補全後的文字原封不動，只是後面接著使用者自己打的字。
    await input.fill(`${completed}這是參數`);
    await expect.poll(() => page.locator(".slash-menu").count(), { timeout: 5000 }).toBe(0); // 含空白，觸發條件已不成立
    await page.locator(".chat-input button:not([disabled])").click();

    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toBe("/slidra-plan 這是參數");
  } finally {
    await cleanup();
  }
});
