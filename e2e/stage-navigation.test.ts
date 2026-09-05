import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";

/**
 * NOOP-60/#197 驗收條件第 3 條：docs/design/docs/05-INTERACTIONS.feature
 * 「舞台導航」的 5 個場景 e2e 化。這裡只驗「這些狀態確實接到了 DOM 上」
 * （transform、cursor、百分比文字）——縮放/平移/抓取的狀態轉換本身已經在
 * packages/web/test/stage-view.test.ts 窮舉邊界，不在這裡重測一次夾取
 * 邏輯（Plan §6.4）。
 *
 * **已知缺口，本檔的測法因此刻意繞開它，不是忽略它**（詳見
 * packages/web/src/shell/Stage.tsx 的 handleWheel 註解與 PR 報告「風險與
 * 未處理項」）：`.canvas` 是 sandboxed iframe，滑鼠停在投影片本體（畫面
 * 絕大部分面積）上時 wheel 事件完全收不到，只有停在 `.canvas-area` 的留
 * 白背景才會觸發。以下「以滾輪縮放」「以滾輪平移」兩個場景刻意把滑鼠移到
 * 留白區域（而非投影片正中央）觸發 wheel，驗證的是 DOM wiring 與
 * stage-view.ts 有沒有接對——不是宣稱使用者對著投影片本體滾動也會動，那
 * 件事目前是真的不會動。
 *
 * 另一個已知缺口：「抓取模式」場景裡 05-INTERACTIONS.feature 明寫「開啟時
 * 清除目前選取」——stage-view.ts 的 toggleHand() 有回傳 selectionCleared
 * 旗標，但 Stage.tsx 目前是 no-op（canvas.ts 沒有提供清除選取的 API，選
 * 取狀態本身是這張骨架票明確排除的範圍）。本檔因此不斷言「按 ✋ 後選取
 * 清除」。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const VIEWPORT = { width: 1440, height: 900 };

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

async function start(prefix: string): Promise<{ started: StartedServer; page: Page }> {
  const started = await startServerFor({ deckDir: demoDir, prefix });
  const page = await openApp(browser, started.server, { viewport: VIEWPORT });
  openPages.push(page);
  return { started, page };
}

async function stageTransform(page: Page): Promise<string> {
  return page.locator(".stage").evaluate((el) => getComputedStyle(el).transform);
}

function scaleOf(matrix: string): number {
  // matrix(a, b, c, d, tx, ty) — a 就是 scale（本殼的 zoom 不含旋轉/歪斜）。
  const m = matrix.match(/matrix\(([^,]+),/);
  if (!m) throw new Error(`無法解析 transform matrix: ${matrix}`);
  return parseFloat(m[1]);
}

/** `.canvas-area` 留白（padding）背景上的一點——不落在 `.stage`／iframe 範
 * 圍內，見本檔頭部註解「已知缺口」。 */
async function gutterPoint(page: Page): Promise<{ x: number; y: number }> {
  const well = await page.locator(".canvas-area").boundingBox();
  if (!well) throw new Error("canvas-area 沒有 boundingBox");
  return { x: well.x + 10, y: well.y + 10 };
}

it("以滾輪縮放：Ctrl/Cmd+wheel 讓舞台縮放係數變大，落在 [25%,400%]，工具列百分比同步改變", async () => {
  const { started, page } = await start("stage-nav-wheel-zoom");
  try {
    const before = scaleOf(await stageTransform(page));
    expect(before).toBeCloseTo(1, 2);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    const point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -240);
    await page.keyboard.up("Control");

    await expect.poll(async () => scaleOf(await stageTransform(page))).toBeGreaterThan(before);
    const after = scaleOf(await stageTransform(page));
    expect(after).toBeGreaterThanOrEqual(0.25);
    expect(after).toBeLessThanOrEqual(4.0);
    const percentText = await page.locator(".dock-zoom-control").textContent();
    expect(percentText).not.toBe("100%");
  } finally {
    await started.cleanup();
  }
});

it("以滾輪平移：不按修飾鍵的 wheel 只改變 translate，scale 與百分比文字不變", async () => {
  const { started, page } = await start("stage-nav-wheel-pan");
  try {
    const beforeTransform = await stageTransform(page);
    const beforeScale = scaleOf(beforeTransform);
    const beforePercent = await page.locator(".dock-zoom-control").textContent();

    const point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(120, 80);

    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);
    const afterScale = scaleOf(await stageTransform(page));
    expect(afterScale).toBeCloseTo(beforeScale, 5);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe(beforePercent);
  } finally {
    await started.cleanup();
  }
});

it("抓取模式：點 ✋ 切換 aria-pressed 與 cursor，拖曳平移舞台", async () => {
  const { started, page } = await start("stage-nav-hand");
  try {
    const handButton = page.locator(".dock-hand-button");
    expect(await handButton.getAttribute("aria-pressed")).toBe("false");

    await handButton.click();
    expect(await handButton.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");

    const beforeTransform = await stageTransform(page);
    const point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y + 30, { steps: 5 });
    await page.mouse.up();

    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);

    await handButton.click();
    expect(await handButton.getAttribute("aria-pressed")).toBe("false");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
  } finally {
    await started.cleanup();
  }
});

it("暫時抓取：按住 Space 期間 cursor 為 grab，放開後恢復；焦點在輸入框時 Space 不啟用", async () => {
  const { started, page } = await start("stage-nav-space");
  try {
    const point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    await page.keyboard.up("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");

    // 焦點在 chat 輸入框時按 Space 不進抓取模式（打出空白字元，不是切換游標）。
    const chatInput = page.locator(".chat-input input");
    await chatInput.click();
    await chatInput.press("Space");
    expect(await chatInput.inputValue()).toBe(" ");
    expect(await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
  } finally {
    await started.cleanup();
  }
});

it("縮放選單：從工具列正上方中央長出，含 −/百分比/+/Fit/預設值，目前值標紅，Fit 回到 100% 並置中", async () => {
  const { started, page } = await start("stage-nav-zoom-menu");
  try {
    await page.locator(".dock-zoom-control").click();
    const menu = page.locator(".zoom-menu");
    expect(await menu.count()).toBe(1);

    const dockBox = await page.locator(".dock").boundingBox();
    const menuBox = await menu.boundingBox();
    if (!dockBox || !menuBox) throw new Error("dock 或 zoom-menu 沒有 boundingBox");
    const dockCenterX = dockBox.x + dockBox.width / 2;
    const menuCenterX = menuBox.x + menuBox.width / 2;
    expect(Math.abs(dockCenterX - menuCenterX)).toBeLessThanOrEqual(2);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(dockBox.y + 1);

    expect(await menu.locator(".zoom-menu-current").textContent()).toBe("100%");
    for (const label of ["50%", "75%", "100%", "150%", "200%", "400%"]) {
      expect(await menu.getByText(label, { exact: true }).count()).toBeGreaterThan(0);
    }
    const currentColor = await menu.locator(".zoom-menu-current").evaluate((el) => getComputedStyle(el).color);
    const brandRedRgb = await page.evaluate(() => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue("--brand-red").trim();
      const div = document.createElement("div");
      div.style.color = hex;
      document.body.appendChild(div);
      const rgb = getComputedStyle(div).color;
      div.remove();
      return rgb;
    });
    expect(currentColor).toBe(brandRedRgb);

    // 先放大，再點 Fit：應回到 100% 且置中（translate 回到初始值）。
    await menu.locator('button[aria-label="放大"]').click();
    await expect.poll(() => menu.locator(".zoom-menu-current").textContent()).not.toBe("100%");
    await menu.getByText("Fit", { exact: true }).click();
    await expect.poll(() => page.locator(".dock-zoom-control").textContent()).toBe("100%");
    const transform = await stageTransform(page);
    expect(scaleOf(transform)).toBeCloseTo(1, 5);
  } finally {
    await started.cleanup();
  }
});
