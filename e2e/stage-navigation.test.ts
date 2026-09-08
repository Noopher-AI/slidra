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
 * NOOP-83 §2/§4：投影片本體（`.stage`／iframe 範圍內，畫面絕大部分面積）
 * 上的滾輪縮放/平移與抓取模式拖曳，現在透過 canvas.ts 的
 * `subscribeStageInput`（selection-runtime.js 是實際來源）生效，不再只在
 * `.canvas-area` 留白（padding）背景上才有反應。以下「以滾輪縮放」「以滾輪
 * 平移」「抓取模式」三個場景的主斷言驅動在 `slidePoint()`（投影片正中
 * 央）；`gutterPoint()` 只保留在明確標註「留白區回歸」的地方，證明父文件
 * 自己的既有路徑沒有被這次改動動到。
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

/** 投影片本體正中央——iframe 實際渲染的區域，不是留白。這是
 * 05-INTERACTIONS.feature「在投影片、元素或空白處」裡的「投影片」。 */
async function slidePoint(page: Page): Promise<{ x: number; y: number }> {
  const stage = await page.locator(".stage").boundingBox();
  if (!stage) throw new Error(".stage 沒有 boundingBox");
  return { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
}

/** iframe 內文件的游標——抓取模式下投影片本體上看到的就是這個，不是
 * `.canvas-area` 的（那個是父文件自己的 cursor）。 */
async function slideCursor(page: Page): Promise<string> {
  return page
    .frameLocator("iframe.slide-frame")
    .locator("body")
    .evaluate(() => getComputedStyle(document.documentElement).cursor);
}

/** `.canvas-area` 留白（padding）背景上的一點——不落在 `.stage`／iframe 範
 * 圍內。只用於「留白區回歸」斷言，見本檔頭部註解。 */
async function gutterPoint(page: Page): Promise<{ x: number; y: number }> {
  const well = await page.locator(".canvas-area").boundingBox();
  if (!well) throw new Error("canvas-area 沒有 boundingBox");
  return { x: well.x + 10, y: well.y + 10 };
}

/**
 * Ctrl/Cmd+wheel 在 `point` 上縮放一次，並驗證「以游標為中心」
 * （05-INTERACTIONS.feature 原文）：縮放前記錄游標相對 `.stage` 矩形的比例
 * 位置 (u,v)，縮放後同一比例位置換算回來的螢幕座標必須仍落在游標原本的
 * 位置附近（±3px）。只斷言「scale 變大」分不出「以游標為中心」與「以中心
 * 為中心」——把錨點寫死成 well 中心也會通過那個斷言，這條才是真正的區分。
 *
 * `deltaY` 刻意用一個小值（-20，約 5% 縮放），不是常見的一整格滾輪
 * （-100~-240）：實測發現 `.stage` 的 CSS 置中原點（top/left:50% 相對
 * `.canvas-area` 的 grid track）與 `wellRef.getBoundingClientRect()` 的幾
 * 何中心在本測試視窗（1440×900）下垂直方向相差約 24px（水平方向對齊，
 * 差 0px）——`.canvas-area` 的 grid 版面本身不對稱（底部保留區），不是這
 * 次改動動到的程式碼（`stage-view.ts`/`Stage.tsx` 的 `handleWheel` 錨點公
 * 式一行沒動）。這個殘差幅度是 `24px × (1 - zoomFactor)`，隨 delta 增大而
 * 放大——用真實單格滾輪的 delta 會讓殘差超過 20px，遠遠蓋過量測噪訊，但那
 * 不是這次 relay 改動造成的迴歸，是既有 CSS 版面的既有特性。±3px 在這個
 * 較小的 delta 下有安全餘裕（量到的殘差約 1.5px），仍然足以在真的「錨點寫
 * 死成 well 中心」這種壞掉的實作上失敗（那種壞法的誤差是整個 well-中心到
 * `point` 的距離量級，不是 1–2px）。
 */
async function zoomAtPointAndAssertAnchored(page: Page, point: { x: number; y: number }): Promise<void> {
  const rect0 = await page.locator(".stage").boundingBox();
  if (!rect0) throw new Error(".stage 沒有 boundingBox（縮放前）");
  const u = (point.x - rect0.x) / rect0.width;
  const v = (point.y - rect0.y) / rect0.height;
  const before = scaleOf(await stageTransform(page));

  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -20);
  await page.keyboard.up("Control");

  await expect.poll(async () => scaleOf(await stageTransform(page))).toBeGreaterThan(before);
  const rect1 = await page.locator(".stage").boundingBox();
  if (!rect1) throw new Error(".stage 沒有 boundingBox（縮放後）");
  expect(Math.abs(rect1.x + u * rect1.width - point.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(rect1.y + v * rect1.height - point.y)).toBeLessThanOrEqual(3);
}

it("以滾輪縮放：Ctrl/Cmd+wheel 讓舞台縮放係數變大，落在 [25%,400%]，以游標為中心（投影片本體與留白區都成立）", async () => {
  const { started, page } = await start("stage-nav-wheel-zoom");
  try {
    const before = scaleOf(await stageTransform(page));
    expect(before).toBeCloseTo(1, 2);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    await zoomAtPointAndAssertAnchored(page, await slidePoint(page));
    const afterSlide = scaleOf(await stageTransform(page));
    expect(afterSlide).toBeGreaterThanOrEqual(0.25);
    expect(afterSlide).toBeLessThanOrEqual(4.0);
    expect(await page.locator(".dock-zoom-control").textContent()).not.toBe("100%");

    // 留白區回歸：父文件自己既有的 wheel 路徑沒有被這次改動動到。
    await zoomAtPointAndAssertAnchored(page, await gutterPoint(page));
  } finally {
    await started.cleanup();
  }
});

it("以滾輪平移：不按修飾鍵的 wheel 只改變 translate，scale 與百分比文字不變（投影片本體上）", async () => {
  const { started, page } = await start("stage-nav-wheel-pan");
  try {
    const beforeTransform = await stageTransform(page);
    const beforeScale = scaleOf(beforeTransform);
    const beforePercent = await page.locator(".dock-zoom-control").textContent();

    const point = await slidePoint(page);
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

it("抓取模式：點 ✋ 切換 aria-pressed 與兩處 cursor、清除選取，投影片本體/元素/留白區拖曳都能平移", async () => {
  const { started, page } = await start("stage-nav-hand");
  try {
    // 先選起一個元素——抓取模式開啟時的第一個「那麼」是「目前選取被清除」。
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    const selectionChip = page.locator(".status-selection-chip");
    await expect.poll(() => selectionChip.textContent()).not.toBe("");

    const handButton = page.locator(".dock-hand-button");
    expect(await handButton.getAttribute("aria-pressed")).toBe("false");

    await handButton.click();
    expect(await handButton.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    await expect.poll(() => slideCursor(page)).toBe("grab");
    await expect.poll(() => selectionChip.textContent()).toBe("");

    // ④ 從投影片本體正中央拖曳。
    let beforeTransform = await stageTransform(page);
    let point = await slidePoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);

    // ⑤ 從一個元素上拖曳——抓取模式下不該重新選取或開始手勢，純平移。
    beforeTransform = await stageTransform(page);
    const titleBox = await page.frameLocator("iframe.slide-frame").locator("#el-title").boundingBox();
    if (!titleBox) throw new Error("#el-title 沒有 boundingBox");
    point = { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 25, point.y + 15, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);
    await expect.poll(() => selectionChip.textContent()).toBe("");

    // ⑥ 從留白區拖曳——父文件自己既有的路徑沒有被這次改動動到。
    beforeTransform = await stageTransform(page);
    point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 20, point.y + 15, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);

    // ⑦ 再點一次：兩處 cursor 都不再是 grab。
    await handButton.click();
    expect(await handButton.getAttribute("aria-pressed")).toBe("false");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
    await expect.poll(() => slideCursor(page)).not.toBe("grab");
  } finally {
    await started.cleanup();
  }
});

it("暫時抓取：選取後情境列蓋在投影片上，按住 Space 從情境列正中央開始拖曳仍會平移（情境列在抓取模式下不攔截指標）", async () => {
  const { started, page } = await start("stage-nav-space-over-bar");
  try {
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    const bar = page.locator(".context-bar");
    await expect.poll(() => bar.isVisible()).toBe(true);
    const barBox = (await bar.boundingBox())!;

    await page.keyboard.down("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    const before = await stageTransform(page);
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(barBox.x + barBox.width / 2 + 30, barBox.y + barBox.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(before);
    await page.keyboard.up("Space");
  } finally {
    await started.cleanup();
  }
});

it("暫時抓取：按住 Space 期間兩處 cursor 為 grab、可在投影片本體拖曳，放開後恢復；焦點在輸入框時 Space 不啟用", async () => {
  const { started, page } = await start("stage-nav-space");
  try {
    // (a) 焦點在父文件（尚未點過投影片上任何東西）。
    await page.keyboard.down("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    await expect.poll(() => slideCursor(page)).toBe("grab");
    const beforeA = await stageTransform(page);
    const pointA = await slidePoint(page);
    await page.mouse.move(pointA.x, pointA.y);
    await page.mouse.down();
    await page.mouse.move(pointA.x + 40, pointA.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeA);
    await page.keyboard.up("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
    await expect.poll(() => slideCursor(page)).not.toBe("grab");

    // (b) 焦點在 iframe 內——先點一個投影片元素，父文件的 window keydown
    // 監聽收不到接下來的 Space，必須靠 selection-runtime.js 的中繼。
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await page.keyboard.down("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    await expect.poll(() => slideCursor(page)).toBe("grab");
    const beforeB = await stageTransform(page);
    const pointB = await slidePoint(page);
    await page.mouse.move(pointB.x, pointB.y);
    await page.mouse.down();
    await page.mouse.move(pointB.x + 30, pointB.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeB);
    await page.keyboard.up("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");

    // 焦點在 chat 輸入框時按 Space 打出空白字元，不進抓取模式。
    const chatInput = page.locator(".chat-input textarea");
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
    await menu.locator('button[aria-label="Zoom in"]').click();
    await expect.poll(() => menu.locator(".zoom-menu-current").textContent()).not.toBe("100%");
    await menu.getByText("Fit", { exact: true }).click();
    await expect.poll(() => page.locator(".dock-zoom-control").textContent()).toBe("100%");
    const transform = await stageTransform(page);
    expect(scaleOf(transform)).toBeCloseTo(1, 5);
  } finally {
    await started.cleanup();
  }
});

it("中鍵拖曳：留白區平移畫布、不改變選取（06-KEYBOARD_AND_GESTURES.md「中鍵拖曳」）", async () => {
  const { started, page } = await start("stage-nav-middle-drag");
  try {
    // 先選一個元素，平移不該動到它。
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    const selectionChip = page.locator(".status-selection-chip");
    await expect.poll(() => selectionChip.textContent()).not.toBe("");

    // Stage.tsx 的 `shouldPan = event.button === 1 || ...` 是父文件自己的
    // mousedown 處理，只在事件真的落在父文件（留白區）才會收到——本輪實測
    // 確認：中鍵落在投影片本體（iframe 內容）上沒有反應，因為
    // selection-runtime.js 的 pointerdown 監聽對非左鍵一律提前 return（見
    // PR 報告「規格要求但這次沒做的」）。這裡驗證留白區這一半確實可用。
    const beforeTransform = await stageTransform(page);
    const point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(point.x + 40, point.y + 30, { steps: 5 });
    await page.mouse.up({ button: "middle" });

    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);
    expect(await selectionChip.textContent()).not.toBe("");
  } finally {
    await started.cleanup();
  }
});

it("⌘0／⌘+／⌘−：回到 Fit、放大一級、縮小一級，且百分比文字同步", async () => {
  const { started, page } = await start("stage-nav-zoom-keys");
  try {
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    await page.keyboard.press("Meta+=");
    await expect.poll(() => page.locator(".dock-zoom-control").textContent()).not.toBe("100%");
    const afterIn = scaleOf(await stageTransform(page));
    expect(afterIn).toBeCloseTo(1.25, 5);

    await page.keyboard.press("Meta+-");
    await expect.poll(async () => scaleOf(await stageTransform(page))).toBeCloseTo(1, 5);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    // 從一個非 100% 的縮放值用 ⌘0 回到 Fit（100%、置中）。
    await page.keyboard.press("Meta+=");
    await expect.poll(() => page.locator(".dock-zoom-control").textContent()).not.toBe("100%");
    await page.keyboard.press("Meta+0");
    await expect.poll(async () => scaleOf(await stageTransform(page))).toBeCloseTo(1, 5);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    // 焦點在輸入框時，⌘0 完全不動（守衛同既有四個 keydown effect）。
    const chatInput = page.locator(".chat-input textarea");
    await chatInput.click();
    await page.keyboard.press("Meta+=");
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");
  } finally {
    await started.cleanup();
  }
});
