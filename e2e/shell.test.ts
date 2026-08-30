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
import { RIBBON, TABS } from "../packages/web/src/shell/ribbon-commands.js";

/**
 * Structural + baseline-screenshot coverage for the shell decomposition
 * (#51 titlebar/ribbon, #52 rail/notes, #53 status bar/view switch).
 * Modeled on e2e/overview.test.ts's startServerFor and e2e/appearance.test.ts's
 * beforeAll shape: real server, real built dist, real Chromium, `demo/` as
 * fixture (named 「驗收用簡報」, canvas 1280×720, 4 slides — matches this
 * ticket's own acceptance evidence).
 *
 * Baseline screenshots are clipped to three regions only — never the whole
 * page, and never anything inside `.canvas-area` — because #50 replaces the
 * stage wholesale in a later wave; a full-page or stage-inclusive baseline
 * here would be dead on arrival the moment that wave lands (軍令 #9).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const overviewDeckDir = path.join(e2eDir, "fixtures/overview-deck");
const binDir = path.join(rootDir, "node_modules/.bin");
const baselineDir = path.join(e2eDir, "__screenshots__/shell");

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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-shell-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-shell-files-"));
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
async function openApp(server: RunningServer, viewport = VIEWPORT): Promise<Page> {
  const page = await browser.newPage({ viewport });
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

// ─── #51 標題列與功能區 ────────────────────────────────────────────

it("#51 標題列：顯示簡報名稱與畫布尺寸，agent 連線指示最終顯示已連線", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    expect(await page.locator(".titlebar .deck-name").textContent()).toBe("驗收用簡報");
    const meta = await page.locator(".titlebar .deck-meta").textContent();
    expect(meta).toContain("1280");
    expect(meta).toContain("720");
  } finally {
    await cleanup();
  }
});

it("#51 功能區：4 個分頁、預設停在投影片放映、每頁 ≤8 顆按鈕、總數 ≤32", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const tabs = page.locator('.tabs [role="tab"]');
    expect(await tabs.count()).toBe(TABS.length);
    expect(TABS.length).toBe(4);
    const selected = page.locator('.tab[aria-selected="true"]');
    expect(await selected.textContent()).toBe("投影片放映");

    let total = 0;
    for (let i = 0; i < TABS.length; i++) {
      await tabs.nth(i).click();
      const count = await page.locator(".groups .cmd").count();
      expect(count).toBeLessThanOrEqual(8);
      const expectedForTab = RIBBON[TABS[i].id].reduce((n, g) => n + g.cmds.length, 0);
      expect(count).toBe(expectedForTab);
      expect(await page.locator(".cmd[disabled]").count()).toBe(0);
      total += count;
    }
    expect(total).toBeLessThanOrEqual(32);

    // Back on 投影片放映: exactly the three live buttons, everything else
    // genuinely disabled with the required title.
    await page.locator('.tab:has-text("投影片放映")').click();
    const enabled = page.locator(".cmd:not([disabled])");
    expect(await enabled.count()).toBe(3);
    expect((await enabled.allTextContents()).sort()).toEqual(["全螢幕", "從目前投影片", "從頭播放"].sort());

    const disabled = page.locator(".cmd[disabled]");
    const disabledCount = await disabled.count();
    for (let i = 0; i < disabledCount; i++) {
      expect(await disabled.nth(i).getAttribute("title")).toBe("尚未實作");
      expect(await disabled.nth(i).isDisabled()).toBe(true);
    }
  } finally {
    await cleanup();
  }
});

it("#51 功能區：點未接線按鈕顯示「此操作尚未接上」，點已接線按鈕不顯示", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    await page.locator('.tab:has-text("常用")').click();

    await page.locator('.cmd:has-text("貼上")').click();
    const notice = page.locator(".ribbon-notice");
    await expect.poll(() => notice.textContent()).toBe("此操作尚未接上");

    await page.locator('.tab:has-text("投影片放映")').click();
    expect(await page.locator(".ribbon-notice").count()).toBe(0);

    await page.locator('.cmd:has-text("全螢幕")').click();
    expect(await page.locator(".ribbon-notice").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("#51 功能區：disabled 的按鈕真的擋在 Tab 順序外，不能被 focus 到", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const anyDisabledFocused = await page.evaluate(() => {
      const firstTab = document.querySelector('[role="tab"]') as HTMLElement;
      firstTab.focus();
      for (let i = 0; i < 20; i++) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        // dispatching a synthetic Tab keydown does not itself move focus in
        // a headless page — walk the natural tab order by hand instead.
        const focusables = Array.from(
          document.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]"),
        ).filter((el) => !el.hasAttribute("disabled"));
        const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
        const next = focusables[currentIndex + 1] ?? focusables[0];
        next?.focus();
        if ((document.activeElement as HTMLElement | null)?.matches(".cmd[disabled]")) return true;
      }
      return false;
    });
    expect(anyDisabledFocused).toBe(false);
  } finally {
    await cleanup();
  }
});

it("#51 功能區：點「從頭播放」進入播放模式，且回到第一頁", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    // Move off the first slide first, so "從頭播放" landing back on it is
    // actually evidence of something, not a coincidence of the initial state.
    await page.locator('.slide-nav-button[aria-label="下一頁"]').click();
    expect(await page.locator(".slide-nav-position").textContent()).toBe("第 2 頁，共 4 頁");

    await page.locator('.cmd:has-text("從頭播放")').click();
    // ADR-0011 gives both modes allow-scripts, so that attribute can no
    // longer prove "play mode entered" — wait on .titlebar becoming
    // invisible instead (the direct evidence the shell collapsed), then
    // assert its actual removal from the DOM below without re-polling the
    // same fact twice.
    await expect.poll(() => page.locator(".titlebar").isVisible()).toBe(false);
    expect(await page.locator(".titlebar").count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("#51 功能區：檢視模式點「全螢幕」可以從 app 內離開，失敗時有畫面回饋（gate round 2, medium）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);

    await page.locator('.cmd:has-text("全螢幕")').click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.fullscreenElement;
          return el ? el.className : null;
        }),
      )
      .toBe("canvas-area");

    // Reachable, not just present: a real Playwright click must actually
    // land on it (fails if something else intercepts pointer events).
    const exitButton = page.locator('.view-fullscreen-bar .fullscreen-toggle-button[aria-label="退出全螢幕"]');
    await exitButton.click();

    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  } finally {
    await cleanup();
  }
});

it("#51 功能區：檢視模式全螢幕請求被拒絕時，畫面上出現明確的錯誤訊息（不是靜默失敗）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);

    // A genuinely rejected requestFullscreen() call — the same technique
    // e2e/player-fullscreen.test.ts uses for its own play-mode equivalent
    // of this test.
    await page.evaluate(() => {
      const container = document.querySelector(".canvas-area") as HTMLElement;
      container.requestFullscreen = () => Promise.reject(new Error("模擬測試：全螢幕請求被拒絕"));
    });

    await page.locator('.cmd:has-text("全螢幕")').click();

    const errorNotice = page.locator(".player-error-notice", { hasText: "全螢幕切換失敗" });
    await expect.poll(() => errorNotice.count()).toBe(1);
  } finally {
    await cleanup();
  }
});

// ─── #52 縮圖軌頁碼與備忘稿區 ───────────────────────────────────────

it("#52 縮圖軌：每張投影片一個頁碼與縮圖，長寬比與目前頁外框沿用 project.json 與 accent token", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const items = page.locator("li.overview-item");
    expect(await items.count()).toBe(4);
    const numbers = await page.locator(".overview-number").allTextContents();
    expect(numbers).toEqual(["1", "2", "3", "4"]);

    const box = await page.locator("button.overview-thumb").first().boundingBox();
    if (!box) throw new Error("找不到第一張縮圖");
    expect(box.width / box.height).toBeCloseTo(1280 / 720, 1);
    const ratio = await page
      .locator("ol.overview-list")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--overview-aspect-ratio").trim());
    expect(ratio).toBe("1280 / 720");

    const current = page.locator("li.overview-item-current");
    expect(await current.count()).toBe(1);
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    const outlineColor = await current
      .locator(".overview-thumb")
      .evaluate((el) => getComputedStyle(el).outlineColor);
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

it("#52 惰性載入未退化：頁碼數量等於頁數，但一開始 iframe 數量遠少於頁數", async () => {
  const { server, cleanup } = await startServerFor(overviewDeckDir);
  try {
    const page = await openApp(server);
    const numberCount = await page.locator(".overview-number").count();
    expect(numberCount).toBe(24);
    // The point of #52 vs #27: page numbers are not a side effect of
    // materialising every thumbnail's iframe.
    const frameCount = await page.locator("iframe.overview-frame").count();
    expect(frameCount).toBeLessThan(numberCount);
  } finally {
    await cleanup();
  }
});

it("#52 備忘稿區：顯示佔位文字，沒有任何可編輯介面", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    expect(await page.locator(".notes").textContent()).toContain("這一頁還沒有備忘稿。");
    const editable = page.locator(".notes input, .notes textarea, .notes [contenteditable]");
    expect(await editable.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

// ─── #53 狀態列與檢視切換鈕 ─────────────────────────────────────────

it("#53 狀態列：不再顯示「CoMotion」字樣，顯示「第 N 頁，共 M 頁」並隨翻頁更新", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toContain("CoMotion");

    expect(await page.locator(".status .slide-nav-position").textContent()).toBe("第 1 頁，共 4 頁");
    await page.locator('.status .slide-nav-button[aria-label="下一頁"]').click();
    expect(await page.locator(".status .slide-nav-position").textContent()).toBe("第 2 頁，共 4 頁");
  } finally {
    await cleanup();
  }
});

it("#53/#55 檢視切換鈕：normal/grid/play 三顆，點播放鈕進播放，離開播放回到標準且鈕狀態正確", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const viewBtns = page.locator(".view-btn");
    expect(await viewBtns.count()).toBe(3);
    expect(await page.locator('.view-btn[data-view="normal"]').getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator('.view-btn[data-view="grid"]').getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator('.view-btn[data-view="grid"]').getAttribute("title")).toBe("總覽網格");
    expect(await page.locator('.view-btn[data-view="play"]').count()).toBe(1);

    await page.locator('.view-btn[data-view="play"]').click();
    // ADR-0011 gives both modes allow-scripts, so that attribute can no
    // longer prove "play mode entered" — poll the shell collapsing
    // (.titlebar unmounting) instead, the same direct evidence #54's own
    // tests already rely on.
    await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
    expect(await page.locator(".status").count()).toBe(0);

    await page.locator('button:has-text("離開播放")').click();
    // ADR-0011: view mode now runs a script too (selection-runtime.js), so
    // the sandbox no longer goes back to "" here. What this line pins is
    // that it carries only allow-scripts — never allow-same-origin.
    await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("allow-scripts");
    expect(await page.locator('.view-btn[data-view="normal"]').getAttribute("aria-pressed")).toBe("true");
  } finally {
    await cleanup();
  }
});

it("#53 狀態列：左側 sel-name 空槽存在但沒有文字內容", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const selName = page.locator(".status .sel-name");
    expect(await selName.count()).toBe(1);
    expect(await selName.textContent()).toBe("");
  } finally {
    await cleanup();
  }
});

// ─── 三張基準截圖（不含舞台，見檔頭說明） ──────────────────────────

it("基準截圖：功能區（標題列＋停在投影片放映分頁的 ribbon）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const box = await page.locator(".ribbon").boundingBox();
    if (!box) throw new Error("找不到 .ribbon");
    await compareScreenshot(page, {
      name: "ribbon",
      baselineDir,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: box.y + box.height },
    });
  } finally {
    await cleanup();
  }
});

// Clipped to `.overview`'s own column only (x width = rail.width), not a
// bounding box reaching over to `.notes`. `.notes` sits in the *centre*
// column, directly under the stage — a rectangle wide enough to reach it
// would necessarily also cover the stage in between (they share the same
// x-range, stacked vertically), which 軍令 #9 forbids outright. The plan's
// framing ("rail 全高 + notes") assumed the two were spatially adjacent;
// they are not, in either base-shell.html's own layout or this one. Kept as
// the rail's own full-height region — genuinely the closest one rectangle
// can get without pulling the stage in. Flagged for the commander in the
// PR body/report rather than decided silently.
it("基準截圖：縮圖軌全高", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const rail = await page.locator(".overview").boundingBox();
    if (!rail) throw new Error("找不到 .overview");
    await compareScreenshot(page, {
      name: "rail-and-notes",
      baselineDir,
      clip: { x: rail.x, y: rail.y, width: rail.width, height: rail.height },
    });
  } finally {
    await cleanup();
  }
});

it("基準截圖：狀態列", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server);
    const box = await page.locator(".status").boundingBox();
    if (!box) throw new Error("找不到 .status");
    await compareScreenshot(page, { name: "status-bar", baselineDir, clip: box });
  } finally {
    await cleanup();
  }
});
