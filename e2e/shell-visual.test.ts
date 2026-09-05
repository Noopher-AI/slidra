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
