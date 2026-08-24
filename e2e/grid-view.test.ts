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
import { compareScreenshot } from "./helpers/screenshot.js";

/**
 * #55's grid view: a third status-bar button that switches the centre
 * column to a grid of the whole deck, without tearing down the ribbon,
 * rail, chat sidebar, or status bar (it is a view, not a modal). Modeled
 * on e2e/shell.test.ts's startServerFor/openApp shape — real server, real
 * built dist, real Chromium.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const overviewDeckDir = path.join(e2eDir, "fixtures/overview-deck");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/grid");

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

async function startServerFor(
  deckDir: string,
): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-grid-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-grid-files-"));
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
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

/** Loads the app and waits for the first slide + the SSE chat stream to be up. */
async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await expect
    .poll(() => page.locator(".agent-dot").textContent().catch(() => null), { timeout: 30_000 })
    .toContain("已連線");
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function switchToGrid(page: Page): Promise<void> {
  await page.locator('.view-btn[data-view="grid"]').click();
  await expect.poll(() => page.locator(".grid-view").count()).toBe(1);
}

it("狀態列第三顆檢視鈕：data-view/title/圖示符合樣板，點下切到網格且 aria-pressed 正確", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const gridBtn = page.locator('.view-btn[data-view="grid"]');
    expect(await gridBtn.count()).toBe(1);
    expect(await gridBtn.getAttribute("title")).toBe("總覽網格");
    expect(await gridBtn.getAttribute("aria-pressed")).toBe("false");
    // Same four-rect icon as base-shell.html:407 (裁決 6 measured separately below).
    const rectCount = await gridBtn.locator("svg rect").count();
    expect(rectCount).toBe(4);

    await switchToGrid(page);
    expect(await gridBtn.getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator('.view-btn[data-view="normal"]').getAttribute("aria-pressed")).toBe("false");
  } finally {
    await cleanup();
  }
});

it("切到網格時外殼四區都還在（功能區、縮圖軌、對話、狀態列），且備忘稿真的不顯示", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await switchToGrid(page);

    expect(await page.locator(".ribbon").isVisible()).toBe(true);
    expect(await page.locator(".overview").isVisible()).toBe(true);
    expect(await page.locator(".chat-sidebar").isVisible()).toBe(true);
    expect(await page.locator(".status").isVisible()).toBe(true);

    // 波指揮官實測到的既有斷線：Notes.tsx 的 `hidden` 屬性單獨存在時對
    // notes.css 的 `display: flex` 無效（origin 贏過 specificity）。這裡
    // 量真正的可視性，不只斷言 hidden 屬性在，否則這條測試量不出那個
    // 斷線曾經存在過。
    expect(await page.locator(".notes").isVisible()).toBe(false);
  } finally {
    await cleanup();
  }
});

it("網格中每一格有頁碼，當前頁有重點色外框（.grid-cell[aria-current='true']）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await switchToGrid(page);

    const cells = page.locator("figure.grid-cell");
    expect(await cells.count()).toBe(4);
    const numbers = await page.locator(".grid-number").allTextContents();
    expect(numbers).toEqual(["第 1 頁", "第 2 頁", "第 3 頁", "第 4 頁"]);

    const current = page.locator('figure.grid-cell[aria-current="true"]');
    expect(await current.count()).toBe(1);
    expect(await current.locator(".grid-number").textContent()).toBe("第 1 頁");

    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    const outlineColor = await current.locator(".grid-thumb").evaluate((el) => getComputedStyle(el).outlineColor);
    const accentRgb = await page.evaluate((value) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    }, accent);
    expect(outlineColor).toBe(accentRgb);
  } finally {
    await cleanup();
  }
});

it("點網格中一格會選到那一頁並切回標準檢視", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await switchToGrid(page);

    await page.locator('button.grid-thumb[aria-label="第 3 頁"]').click();

    // 切回標準檢視：grid-view 從 DOM 移除，view-btn 狀態回到 normal。
    await expect.poll(() => page.locator(".grid-view").count()).toBe(0);
    expect(await page.locator('.view-btn[data-view="normal"]').getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator(".status .slide-nav-position").textContent()).toBe("第 3 頁，共 4 頁");
  } finally {
    await cleanup();
  }
});

it("#27/#52 惰性載入沿用到網格：頁碼數量等於頁數，但一開始 iframe 數量遠少於頁數", async () => {
  const { server, cleanup } = await startServerFor(overviewDeckDir);
  try {
    const page = await openApp(server);
    await switchToGrid(page);

    const numberCount = await page.locator(".grid-number").count();
    expect(numberCount).toBe(24);
    const frameCount = await page.locator("iframe.grid-frame").count();
    expect(frameCount).toBeLessThan(numberCount);
  } finally {
    await cleanup();
  }
});

it("離開網格再回來不會孤立畫布 iframe：切網格、切回標準、翻頁仍然正常運作", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const slideText = () => page.frameLocator("iframe.slide-frame").locator("svg text").first();

    await switchToGrid(page);
    await page.locator('.view-btn[data-view="normal"]').click();
    await expect.poll(() => page.locator(".grid-view").count()).toBe(0);

    // The failure mode this guards is silent (a permanently white centre
    // column, nothing thrown) — assert the iframe is still there AND that
    // paging it actually changes what is painted, not just that the
    // element exists.
    await expect.poll(() => slideText().textContent().catch(() => null), { timeout: 10_000 }).not.toBeNull();
    const firstSlideText = await slideText().textContent();

    await page.locator('.status .slide-nav-button[aria-label="下一頁"]').click();
    await expect.poll(() => slideText().textContent().catch(() => firstSlideText)).not.toBe(firstSlideText);
    expect(await page.locator(".status .slide-nav-position").textContent()).toBe("第 2 頁，共 4 頁");
  } finally {
    await cleanup();
  }
});

// 裁決 5 的第二半：GridView 的 render 條件是
// `view === "grid" && state.mode !== "play"`，不是單看 `view`。這條測項
// 就是守住那個接縫本身——波指揮官的突變測試把 Stage.tsx 那一行放寬成只看
// `view` 之後，先前七條測項一條都沒有變紅，證明這個接縫先前沒有測試守著。
// 這裡直接量「網格檢視下按下播放」這個真實場景下的效果（DOM 是否還有
// .grid-view、播放黑幕是否成立），不是量 `view` 這個 state 本身的值。
it("網格檢視下按下播放：網格從 DOM 消失、播放黑幕不被網格蓋住（裁決 5 第二半）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await switchToGrid(page);
    expect(await page.locator(".grid-view").count()).toBe(1);

    await page.locator('.view-btn[data-view="play"]').click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");

    // 量效果，不是量 state：網格必須真的從 DOM 移除，不是疊在黑幕上面看
    // 不見。若只看 `view === "grid"`（拿掉 `state.mode !== "play"` 那半），
    // `.grid-view` 在這裡仍然是 1。
    expect(await page.locator(".grid-view").count()).toBe(0);

    // 播放黑幕確實成立，順帶證明黑幕沒有被網格蓋住（若網格還在，這個
    // 顏色量到的會是網格的 --s-well 背景，不是黑）。play.css:26-27
    // `.app[data-mode="play"] .canvas { background: #000; }` 是黑幕真正
    // 生效的元素——量過 `.canvas-area`（--s-well 灰）與 `.stage`（尚未套用
    // 播放樣式的白）都不是黑，只有 `.canvas` 本身是。
    const canvasBg = await page.locator(".canvas-area .canvas").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(canvasBg).toBe("rgb(0, 0, 0)");

    // 離開播放後回到哪個檢視：實測到的行為是「回到網格」，不是「回到標準」
    // ——`view` state 全程都沒被 handleExitPlay 動過（它只管 `mode`），
    // `view === "grid"` 在按下播放前就已經成立，離開播放只是讓
    // `state.mode !== "play"` 這半重新為真，GridView 的 render 條件兩半
    // 又同時成立。這是 裁決 5 讓 `view`／`mode` 兩個 state 正交的直接結果，
    // 不是偶然：作者在網格檢視按下播放，離開播放後應該回到他原本在看的
    // 網格，而不是被靜悄悄地丟回標準檢視。
    await page.locator('button:has-text("離開播放")').click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("view");
    expect(await page.locator(".grid-view").count()).toBe(1);
    expect(await page.locator('.view-btn[data-view="grid"]').getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator('.view-btn[data-view="normal"]').getAttribute("aria-pressed")).toBe("false");
  } finally {
    await cleanup();
  }
});

it("基準截圖：總覽網格檢視", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await switchToGrid(page);
    // demo/slides/002.svg's thumbnail references an external image
    // (assets/photo.svg) fetched inside its iframe's srcdoc — that fetch
    // is asynchronous relative to `.grid-view`'s own materialisation, so a
    // screenshot taken immediately after switchToGrid() races it (observed
    // directly: two otherwise-identical runs produced 54315 vs 69933
    // bytes). Wait for the network to go quiet before capturing, the same
    // way openApp() already waits for the bundled font before any other
    // baseline in this repo.
    await expect.poll(() => page.locator("iframe.grid-frame").count()).toBe(4);
    await page.waitForLoadState("networkidle");
    // fullPage: true (screenshot.ts's own comment says it exists for this
    // ticket) — the grid can hold more slides than fit in one viewport.
    await compareScreenshot(page, { name: "grid-view", baselineDir, fullPage: true });
  } finally {
    await cleanup();
  }
});
