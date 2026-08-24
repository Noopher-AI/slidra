import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { compareScreenshot } from "./helpers/screenshot.js";

/**
 * 播放模式外觀 (issue #54): pure black full-bleed stage, the floating
 * control bar (上一步/下一步/頁碼/全螢幕/離開播放), the idle-hide of both
 * cursor and control bar together, and the survival of the three floating
 * notices through that idle-hide. `demo/` is used for the control-bar/
 * idle/screenshot tests (no effect list to fight the paging assertions);
 * `fixtures/broken-effects-deck/` is reused from
 * e2e/player-effect-error.test.ts for the one test that needs a real
 * `.player-error-notice` on screen.
 *
 * Viewport fixed at 1440×900, same as e2e/appearance.test.ts and
 * docs/design/base-shell.html's own static frame ("樣板永遠以 1440×900 的
 * 視窗呈現").
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const brokenEffectsDeckDir = path.join(e2eDir, "fixtures/broken-effects-deck");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/play");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

async function startServerFor(
  deckDir: string,
  prefix: string,
): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), `co-motion-e2e-${prefix}-home-`));
  const comotDir = await mkdtemp(path.join(tmpdir(), `co-motion-e2e-${prefix}-files-`));
  process.env["CO_MOTION_HOME"] = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, `${prefix}.comot`);
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
    cleanup: async () => {
      await server.close();
      delete process.env["CO_MOTION_HOME"];
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

/** Loads the app and waits for the first slide to actually be painted before returning the page. */
async function openApp(deckDir: string, prefix: string): Promise<{ page: Page; cleanup: () => Promise<void> }> {
  const { server, cleanup } = await startServerFor(deckDir, prefix);
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(() => document.fonts.ready);

  return { page, cleanup };
}

/**
 * Same wait as e2e/player-media.test.ts's own waitForPlayerFocus: the
 * play iframe is torn down and rebuilt with `allow-scripts` on entering
 * play, and a click/keypress fired before the fresh runtime posts "ready"
 * has no listener to reach.
 */
async function enterPlay(page: Page): Promise<void> {
  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");
  await expect.poll(() => page.locator(".player-focus-notice").count(), { timeout: 10_000 }).toBe(0);
}

it("控制列的上一步／下一步換的是投影片本身（裁決 3：不是效果步驟）", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-nav");
  try {
    await enterPlay(page);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const titleText = () => playFrame().locator("svg text").first().textContent().catch(() => null);

    const firstSlideText = await titleText();

    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await expect.poll(titleText, { timeout: 30_000 }).not.toBe(firstSlideText);
    const secondSlideText = await titleText();

    await page.locator('.play-bar button[aria-label="上一步"]').click();
    await expect.poll(titleText, { timeout: 30_000 }).toBe(firstSlideText);
    expect(secondSlideText).not.toBe(firstSlideText);

    // 頁碼同步更新（樣板的 `N / M` 形式），且「上一步」在第 1 頁時停用
    // （不會繞回最後一頁）。
    expect(await page.locator(".play-bar-position").textContent()).toBe("1 / 4");
    expect(await page.locator('.play-bar button[aria-label="上一步"]').isDisabled()).toBe(true);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("閒置 2.5 秒後游標與控制列一起隱去，滑鼠一動同時再現", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-idle");
  try {
    await enterPlay(page);

    const app = page.locator(".app");
    const bar = page.locator(".play-bar");
    const opacityOf = (locator: typeof bar) => locator.evaluate((el) => getComputedStyle(el).opacity);
    const cursorOf = () => app.evaluate((el) => getComputedStyle(el).cursor);

    // 剛進入播放：控制列可見，游標正常。
    await expect.poll(() => opacityOf(bar)).toBe("1");
    expect(await cursorOf()).toBe("default");

    // 閒置超過 2.5 秒：兩者一起隱去。
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("0");
    expect(await cursorOf()).toBe("none");

    // 滑鼠一動：兩者同時再現。移到控制列附近、避開投影片 iframe——跨
    // frame 邊界的滑鼠移動不會讓上層文件收到連續的 mousemove 事件，只有
    // 停在上層文件範圍內移動才算數。
    await page.mouse.move(60, 850);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("1");
    expect(await cursorOf()).toBe("default");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("三種浮動通知（焦點提示／播放錯誤／全螢幕錯誤）在控制列隱去後依然顯示", async () => {
  const { page, cleanup } = await openApp(brokenEffectsDeckDir, "play-appearance-notices");
  try {
    await page.locator('.view-btn[data-view="play"]').click();

    // 播放錯誤：這份 deck 第 1 頁的效果清單解析必定失敗（見
    // e2e/player-effect-error.test.ts）。canvas.ts 的解析失敗路徑（見
    // renderPlay 的 catch 分支）把 srcdoc 換成沒有 player-runtime 的靜態
    // 版本，所以這一頁永遠不會送出 "ready"——focusPlayer() 因此永遠不會
    // 被呼叫，playerHasFocus 停在初始值 false。焦點提示與播放錯誤兩者因
    // 此是同一次失敗、同時、真的成立，不需要另外偷焦點。
    const errorNotice = page.locator(".player-error-notice", { hasText: "效果清單" });
    await expect.poll(() => errorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const focusNotice = page.locator(".player-focus-notice");
    expect(await focusNotice.count()).toBeGreaterThan(0);

    // 全螢幕錯誤：沿用 e2e/player-fullscreen.test.ts 已驗證過的做法——用
    // 一個一定會拒絕的 requestFullscreen 替身製造真實的錯誤（不是假造
    // 成功又謊報失敗），再按下全螢幕鈕。
    await page.evaluate(() => {
      const container = document.querySelector(".canvas-area") as HTMLElement;
      container.requestFullscreen = () => Promise.reject(new Error("模擬測試：全螢幕請求被拒絕"));
    });
    await page.locator(".play-bar .fullscreen-toggle-button").click();
    const fullscreenErrorNotice = page.locator(".player-error-notice", { hasText: "全螢幕切換失敗" });
    await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    const opacityOf = (locator: ReturnType<Page["locator"]>) =>
      locator.first().evaluate((el) => getComputedStyle(el).opacity);

    // 通知本身不在 .play-bar 裡，閒置隱藏規則只作用在 .play-bar，所以三
    // 種通知在控制列隱去後仍應可見——它們是錯誤，不是 chrome。這裡不再動
    // 滑鼠（上面的 evaluate()/click() 已經是最後的互動），單純等待閒置。
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(page.locator(".play-bar")), { timeout: 5_000 }).toBe("0");
    expect(await opacityOf(focusNotice)).toBe("1");
    expect(await opacityOf(errorNotice)).toBe("1");
    expect(await opacityOf(fullscreenErrorNotice)).toBe("1");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("播放模式下，功能區、縮圖軌、對話、備忘稿、狀態列都不在 DOM 裡", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-dom");
  try {
    // 進入播放前：這些元素都在（標準檢視的既有外殼）。DOM count，不是
    // 可見性——#54 明文要求「不在 DOM 裡」，`display:none`／`opacity:0`
    // 都不算數，只有 querySelector/count 為 0 才算數。
    expect(await page.locator(".titlebar").count()).toBe(1);
    expect(await page.locator(".ribbon").count()).toBe(1);
    expect(await page.locator(".overview").count()).toBe(1);
    expect(await page.locator(".overview-list").count()).toBe(1);
    expect(await page.locator(".chat-sidebar").count()).toBe(1);
    expect(await page.locator(".notes").count()).toBe(1);
    expect(await page.locator(".status-bar").count()).toBe(1);

    await enterPlay(page);

    expect(await page.locator(".titlebar").count()).toBe(0);
    expect(await page.locator(".ribbon").count()).toBe(0);
    expect(await page.locator(".overview").count()).toBe(0);
    expect(await page.locator(".overview-list").count()).toBe(0);
    expect(await page.locator(".chat-sidebar").count()).toBe(0);
    expect(await page.locator(".notes").count()).toBe(0);
    expect(await page.locator(".status-bar").count()).toBe(0);

    // 背景純黑，投影片置中且完整可見 (AC1/AC2)：舞台底本身即 #000
    // （styles/play.css 既有的 `.canvas` 規則），這裡量測整個播放黑幕
    // 容器 `.canvas-area` 的背景色，確認不是殘留的舞台底表面色。
    const bg = await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(0, 0, 0)");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("離開播放模式後，總覽縮圖軌重新掛載且可點擊換頁（overview 模組存活證明）", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-overview-survival");
  try {
    // 進入播放，再離開——`<Rail>` 卸載又重掛載一次。
    await enterPlay(page);
    await page.locator(".play-bar .play-toggle-button.leave").click();
    await expect.poll(() => page.locator(".view-btn[data-view='play']").count(), { timeout: 10_000 }).toBe(1);

    // 只數元素不足以證明模組還活著（見波簡報的「陷阱」一節）：必須點
    // 一下縮圖，實際觀察投影片真的換了。
    const thumbnails = page.locator(".overview-thumb");
    await expect.poll(() => thumbnails.count(), { timeout: 10_000 }).toBe(4);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const titleText = () => playFrame().locator("svg text").first().textContent().catch(() => null);
    const firstSlideText = await titleText();

    await page.locator('button[aria-label="第 2 頁"]').click();
    await expect.poll(titleText, { timeout: 30_000 }).not.toBe(firstSlideText);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("基準截圖：控制列浮現態", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-shot-awake");
  try {
    await enterPlay(page);
    await compareScreenshot(page, { name: "play-awake", baselineDir });
  } finally {
    await page.close();
    await cleanup();
  }
});

it("基準截圖：控制列隱藏態", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-shot-asleep");
  try {
    await enterPlay(page);
    await page.waitForTimeout(2800);
    await expect
      .poll(() => page.locator(".play-bar").evaluate((el) => getComputedStyle(el).opacity), { timeout: 5_000 })
      .toBe("0");
    await compareScreenshot(page, { name: "play-asleep", baselineDir });
  } finally {
    await page.close();
    await cleanup();
  }
});
