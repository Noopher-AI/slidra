import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";

/**
 * NOOP-60/#197 驗收條件第 2b 條：「截圖比對通過（外殼預設狀態、縮放選單、
 * 抓取模式游標）」。3 個情境 × 2 個 viewport = 6 張基準。
 *
 * 基準截圖依 AGENTS.md「視覺回歸的把關分工」與本票 Plan §6.3：只能由
 * `ubuntu-latest` 上的 `e2e.yml`（`update_baselines`）產生，本機（尤其這
 * 個 sandbox pod）比對結果不算驗收證據——本機一律
 * `SKIP_APPEARANCE_BASELINES=1` 跳過像素比對，只驗證這裡的互動流程本身
 * 能正確走到「準備好截圖」的狀態（例如縮放選單真的開著、✋ 真的按下去）。
 *
 * 抓取模式的游標不會進到截圖裡（Playwright 截圖不含系統游標圖示），所以
 * 除了截圖之外另外斷言 `getComputedStyle(...).cursor === "grab"`。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const stylePanelDeckDir = path.join(e2eDir, "fixtures/style-panel-deck");
const baselineDir = path.join(e2eDir, "__screenshots__/shell-v3");

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
];

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

/** [E5.T7]/F-17 決定 8: the context bar is ghost (`pointer-events: none`) until the pointer hovers it long enough to solidify — a click before this never reaches a button, it always resolves to the iframe underneath instead. */
async function hoverContextBar(page: Page): Promise<void> {
  const box = (await page.locator(".context-bar").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
}

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

for (const viewport of VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`;

  it(`基準截圖：外殼預設狀態 (${label})`, async () => {
    const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: `shell-visual-default-${label}` });
    try {
      const page = await openApp(browser, started.server, { viewport });
      openPages.push(page);
      await settleForScreenshot(page);
      await compareScreenshot(page, { name: `default-${label}`, baselineDir });
    } finally {
      await started.cleanup();
    }
  });

  it(`基準截圖：縮放選單開啟 (${label})`, async () => {
    const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: `shell-visual-zoom-${label}` });
    try {
      const page = await openApp(browser, started.server, { viewport });
      openPages.push(page);
      await page.locator(".dock-zoom-control").click();
      await expect.poll(() => page.locator(".zoom-menu").count()).toBe(1);
      await settleForScreenshot(page);
      await compareScreenshot(page, { name: `zoom-menu-${label}`, baselineDir });
    } finally {
      await started.cleanup();
    }
  });

  it(`基準截圖：抓取模式 (${label})，另外斷言游標為 grab（截圖本身看不到游標圖示）`, async () => {
    const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: `shell-visual-hand-${label}` });
    try {
      const page = await openApp(browser, started.server, { viewport });
      openPages.push(page);
      await page.locator(".dock-hand-button").click();
      await expect.poll(() => page.locator(".dock-hand-button").getAttribute("aria-pressed")).toBe("true");
      expect(await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
      await settleForScreenshot(page);
      await compareScreenshot(page, { name: `hand-mode-${label}`, baselineDir });
    } finally {
      await started.cleanup();
    }
  });

}

// [E2.T17] test-prune (plan §6.3): the Text 插入面板基準 used to run inside
// the VIEWPORTS loop above (both 1280×720 and 2560×1440) — dropped down to
// 1280×720 only here, for the exact same reason the Style panel section
// right below already gives its own 2560 skip: `.floating-layer`/`.dock-panel`
// is a fixed-width layer centered over the dock, so the 2560 viewport
// produces no new layout information, only a doubled pixel-comparison cost.
// [E2.T17]'s own four new Shape/Image/Video/Audio panel baselines
// (below) are 1280×720-only from the start for the same reason (D8).
it("基準截圖：Text 插入面板開啟 (1280x720)", async () => {
  const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: "shell-visual-text-panel-1280x720" });
  try {
    const page = await openApp(browser, started.server, { viewport: { width: 1280, height: 720 } });
    openPages.push(page);
    await page.getByRole("button", { name: "Text" }).click();
    await expect.poll(() => page.locator(".text-panel").count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "text-panel-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

// [E2.T17] plan §5 A7/D8: Shape 選單、Image／Video／Audio 插入面板的截圖比
// 對——同上，1280×720-only，同一個固定寬浮層沒有第二個 viewport 值得比對
// 的理由。
it("基準截圖：Shape 選單開啟 (1280x720)", async () => {
  const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: "shell-visual-shape-menu" });
  try {
    const page = await openApp(browser, started.server, { viewport: { width: 1280, height: 720 } });
    openPages.push(page);
    await page.getByRole("button", { name: "Shape" }).click();
    await expect.poll(() => page.locator(".shape-menu").count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "shape-menu-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

it("基準截圖：Image 插入面板開啟 (1280x720)", async () => {
  const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: "shell-visual-image-panel" });
  try {
    const page = await openApp(browser, started.server, { viewport: { width: 1280, height: 720 } });
    openPages.push(page);
    await page.getByRole("button", { name: "Image" }).click();
    await expect.poll(() => page.locator(".media-panel[aria-label='Image']").count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "image-panel-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

it("基準截圖：Video 插入面板開啟 (1280x720)", async () => {
  const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: "shell-visual-video-panel" });
  try {
    const page = await openApp(browser, started.server, { viewport: { width: 1280, height: 720 } });
    openPages.push(page);
    await page.getByRole("button", { name: "Video" }).click();
    await expect.poll(() => page.locator(".media-panel[aria-label='Video']").count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "video-panel-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

it("基準截圖：Audio 插入面板開啟 (1280x720)", async () => {
  const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: "shell-visual-audio-panel" });
  try {
    const page = await openApp(browser, started.server, { viewport: { width: 1280, height: 720 } });
    openPages.push(page);
    await page.getByRole("button", { name: "Audio" }).click();
    await expect.poll(() => page.locator(".media-panel[aria-label='Audio']").count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "audio-panel-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

// #200 (NOOP-69) §5-H: Style › Page／Object×3 類型的截圖比對。右欄是固定寬
// （side-panel 340px），2560 版本不會有不同的排版資訊，卻讓 CI 的像素比對
// 成本翻倍——只做 1280×720 這一個 viewport（計畫 §5 決定）。用自己的
// `style-panel-deck`，不是 demo/，跟 e2e/style-panel.test.ts 同一份 fixture。
const STYLE_VIEWPORT = { width: 1280, height: 720 };

it("基準截圖：Style › Page，無選取", async () => {
  const started: StartedServer = await startServerFor({ deckDir: stylePanelDeckDir, prefix: "shell-visual-style-page" });
  try {
    const page = await openApp(browser, started.server, { viewport: STYLE_VIEWPORT });
    openPages.push(page);
    await page.locator('[role="tab"][data-tab="style"]').click();
    await expect.poll(() => page.locator('[data-attr="canvas-width"] input').count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "style-page-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

it("基準截圖：Style › Object，選取文字框", async () => {
  const started: StartedServer = await startServerFor({ deckDir: stylePanelDeckDir, prefix: "shell-visual-style-object-text" });
  try {
    const page = await openApp(browser, started.server, { viewport: STYLE_VIEWPORT });
    openPages.push(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-text").click();
    await hoverContextBar(page);
    await page.locator('button[title="Edit style"]').click();
    await expect.poll(() => page.locator('[data-section="text"]').count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "style-object-text-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

it("基準截圖：Style › Object，選取形狀", async () => {
  const started: StartedServer = await startServerFor({ deckDir: stylePanelDeckDir, prefix: "shell-visual-style-object-shape" });
  try {
    const page = await openApp(browser, started.server, { viewport: STYLE_VIEWPORT });
    openPages.push(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();
    await hoverContextBar(page);
    await page.locator('button[title="Edit style"]').click();
    await expect.poll(() => page.locator('[data-section="shape"]').count()).toBe(1);
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "style-object-shape-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});

it("基準截圖：Style › Object，捲到底讓 Table／Chart 骨架段完整入鏡", async () => {
  const started: StartedServer = await startServerFor({ deckDir: stylePanelDeckDir, prefix: "shell-visual-style-object-table" });
  try {
    const page = await openApp(browser, started.server, { viewport: STYLE_VIEWPORT });
    openPages.push(page);
    await page.frameLocator("iframe.slide-frame").locator("#el-a").click();
    await hoverContextBar(page);
    await page.locator('button[title="Edit style"]').click();
    await expect.poll(() => page.locator('[data-section="chart"]').count()).toBe(1);
    await page.locator(".style-object-panel").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await settleForScreenshot(page);
    await compareScreenshot(page, { name: "style-object-table-1280x720", baselineDir });
  } finally {
    await started.cleanup();
  }
});
