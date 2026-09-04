import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp as openAppHelper, requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

/**
 * 總覽網格與播放介面視覺更新 (E1.T6/#185). Behavioural coverage only — no
 * appearance baselines here (see AGENTS.md「視覺回歸的把關分工」and this
 * PR's body: `play/play-awake.png`、`play/play-asleep.png`、
 * `grid/grid-view.png` are expected to go stale and can only be
 * re-produced by a human triggering `.github/workflows/e2e.yml` with
 * `update_baselines`). Every assertion below reads real Chromium layout
 * (boundingBox()/getComputedStyle()), the same rule
 * e2e/side-panel-visual.test.ts's header states — a CSS selector or
 * property can be rewritten to an equivalent form without the rendered box
 * model changing, and that rewrite shouldn't fail this file. The one
 * exception — literal colour/duration/easing values and selector shape in
 * source text — is a source-text assertion and lives in
 * packages/web/test/play-grid-css-tokens.test.ts instead, not here.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const brokenEffectsDeckDir = path.join(e2eDir, "fixtures/broken-effects-deck");

/** The three desktop sizes the ticket's AC names explicitly (plan §3.7 / e2e/responsive-shell.test.ts). */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
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

async function startServerFor(): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  return startServerForHelper({ deckDir: demoDir, prefix: "play-grid-visual" });
}

async function openApp(server: RunningServer, viewport: { width: number; height: number }): Promise<Page> {
  const page = await openAppHelper(browser, server, { viewport });
  openPages.push(page);
  return page;
}

async function switchToGrid(page: Page): Promise<void> {
  await page.locator('.view-btn[data-view="grid"]').click();
  await expect.poll(() => page.locator(".grid-view").count()).toBe(1);
}

async function switchToPlay(page: Page): Promise<void> {
  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");
}

/** Resolves a `--token` from `:root` to its literal CSS text (e.g. `#c41e3a`, `rgba(0, 0, 0, 0.5)`). */
async function resolveToken(page: Page, name: string): Promise<string> {
  return page.evaluate((tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(), name);
}

/** Same probe-span technique as e2e/side-panel-visual.test.ts's resolvedRgb — the only reliable way to
 * compare an arbitrary CSS colour string against a getComputedStyle() result, which the browser always
 * normalises to rgb(...)/rgba(...). */
async function resolvedRgb(page: Page, cssColorValue: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  }, cssColorValue);
}

async function boundingBoxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} 沒有 boundingBox（不在畫面上或未渲染）`);
  return box;
}

function withinViewport(
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
}

// ─── A3：.play-bar 遷移到 play.css 後仍是像素中性 ──────────────────────
it("A3：.play-bar 從 shell.css 遷到 play.css 後，背景/邊框/圓角/按鈕尺寸像素不變", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToPlay(page);

    const bar = await page.locator(".play-bar").evaluate((el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, borderColor: s.borderColor, borderRadius: s.borderRadius };
    });
    expect(bar.background).toBe("rgba(32, 31, 30, 0.82)");
    expect(bar.borderColor).toBe("rgba(255, 255, 255, 0.1)");
    expect(bar.borderRadius).toBe("5px");

    const button = await page.locator(".play-bar button").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { borderRadius: s.borderRadius, height: s.height };
    });
    expect(button.borderRadius).toBe("2px");
    expect(button.height).toBe("26px");
  } finally {
    await cleanup();
  }
});

// ─── B1：.play-bar 按鈕、.grid-thumb 有可見的 focus-visible 回饋 ────────
it("B1：鍵盤 focus 播放控制列按鈕時顯示可見外框，顏色為 --focus-ring", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToPlay(page);

    const leaveButton = page.locator(".play-bar .play-toggle-button.leave");
    // 先按一次 Tab 把輸入模態旗標翻回 keyboard（同 e2e/side-panel-visual.test.ts 的既有作法），
    // 上面 switchToPlay 已經點過滑鼠，模態旗標停在 pointer。
    await page.keyboard.press("Tab");
    await leaveButton.focus();
    const outlineStyle = await leaveButton.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe("none");

    const focusRing = await resolveToken(page, "--focus-ring");
    const focusRingRgb = await resolvedRgb(page, focusRing);
    const outlineColor = await leaveButton.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outlineColor).toBe(focusRingRgb);
  } finally {
    await cleanup();
  }
});

it("B1：鍵盤 focus .grid-thumb 時顯示可見的 box-shadow 外框，顏色為 --focus-ring", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToGrid(page);

    const thumb = page.locator('button.grid-thumb[aria-label="第 2 頁"]');
    await page.keyboard.press("Tab");
    await thumb.focus();
    const boxShadow = await thumb.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toBe("none");

    const focusRing = await resolveToken(page, "--focus-ring");
    const focusRingRgb = await resolvedRgb(page, focusRing);
    expect(boxShadow).toContain(focusRingRgb);
  } finally {
    await cleanup();
  }
});

// ─── B2：disabled 的播放控制列按鈕，hover 不改變背景色 ──────────────────
it("B2：第一頁時「上一步」是 disabled，hover 不改變背景色", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToPlay(page);

    const prevButton = page.locator('.play-bar button[aria-label="上一步"]');
    expect(await prevButton.isDisabled()).toBe(true);
    const before = await prevButton.evaluate((el) => getComputedStyle(el).backgroundColor);
    await prevButton.hover({ force: true });
    const after = await prevButton.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(after).toBe(before);
  } finally {
    await cleanup();
  }
});

// ─── B3：網格目前投影片有兩個獨立非顏色信號 ─────────────────────────────
it("B3：網格目前投影片的頁碼字重比其他頁重（除了既有的 accent 外框）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToGrid(page);

    const current = page.locator('figure.grid-cell[aria-current="true"] .grid-number');
    const other = page.locator('figure.grid-cell[aria-current="false"] .grid-number').first();
    const currentWeight = await current.evaluate((el) => getComputedStyle(el).fontWeight);
    const otherWeight = await other.evaluate((el) => getComputedStyle(el).fontWeight);
    expect(Number(currentWeight)).toBeGreaterThan(Number(otherWeight));
    expect(currentWeight).toBe("500");
  } finally {
    await cleanup();
  }
});

// ─── B4：.grid-thumb 與 .overview-thumb 的靜置圓角相同 ─────────────────
it("B4：.grid-thumb 與縮圖軌 .overview-thumb 的 border-radius 相同", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    const railRadius = await page.locator(".overview-thumb").first().evaluate((el) => getComputedStyle(el).borderRadius);
    await switchToGrid(page);
    const gridRadius = await page.locator(".grid-thumb").first().evaluate((el) => getComputedStyle(el).borderRadius);
    expect(gridRadius).toBe(railRadius);
  } finally {
    await cleanup();
  }
});

// ─── C2：投影片 iframe 內容不被產品主題改色 ────────────────────────────
it("C2：網格縮圖 iframe 的 filter/mix-blend-mode/opacity 都是未被改色的預設值", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToGrid(page);
    await expect.poll(() => page.locator("iframe.grid-frame").count()).toBeGreaterThan(0);

    const style = await page.locator("iframe.grid-frame").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { filter: s.filter, mixBlendMode: s.mixBlendMode, opacity: s.opacity };
    });
    expect(style.filter).toBe("none");
    expect(style.mixBlendMode).toBe("normal");
    expect(style.opacity).toBe("1");
  } finally {
    await cleanup();
  }
});

// ─── C3：播放模式黑幕仍是純黑（遷移後重述一次，防止打錯字面值） ────────
it("C3：播放模式下 .canvas 與 .canvas-area 背景仍是 rgb(0, 0, 0)", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToPlay(page);
    const canvasBg = await page.locator(".canvas-area .canvas").evaluate((el) => getComputedStyle(el).backgroundColor);
    const areaBg = await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(canvasBg).toBe("rgb(0, 0, 0)");
    expect(areaBg).toBe("rgb(0, 0, 0)");
  } finally {
    await cleanup();
  }
});

// ─── D1：三個尺寸下播放控制列與每顆按鈕都完整落在 viewport 內 ──────────
for (const viewport of VIEWPORTS) {
  it(`D1：${viewport.width}×${viewport.height} 下 .play-bar 與每顆按鈕都在 viewport 內`, async () => {
    const { server, cleanup } = await startServerFor();
    try {
      const page = await openApp(server, viewport);
      await switchToPlay(page);

      const barBox = await boundingBoxOf(page, ".play-bar");
      expect(withinViewport(barBox, viewport)).toBe(true);

      const buttons = page.locator(".play-bar button");
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const box = await buttons.nth(i).boundingBox();
        if (!box) throw new Error(`.play-bar button[${i}] 沒有 boundingBox`);
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(withinViewport(box, viewport)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });
}

// ─── D2/D3：三個尺寸下網格格子不重疊，欄數 ≥2，縮圖寬度 ≥160px ─────────
for (const viewport of VIEWPORTS) {
  it(`D2/D3：${viewport.width}×${viewport.height} 下網格格子不重疊、欄數 ≥2、縮圖寬度 ≥160px`, async () => {
    const { server, cleanup } = await startServerFor();
    try {
      const page = await openApp(server, viewport);
      await switchToGrid(page);

      const cells = page.locator("figure.grid-cell");
      const count = await cells.count();
      expect(count).toBeGreaterThan(0);
      const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (let i = 0; i < count; i++) {
        const box = await cells.nth(i).boundingBox();
        if (!box) throw new Error(`figure.grid-cell[${i}] 沒有 boundingBox`);
        boxes.push(box);
      }

      // D2：任兩格不重疊。
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
          expect(overlaps, `cell[${i}] × cell[${j}]`).toBe(false);
        }
      }

      // D3：第一列欄數 ≥2（用第一列各格的 y 判定同一列），縮圖寬度 ≥160px。
      const firstRowY = boxes[0].y;
      const firstRowCount = boxes.filter((box) => Math.abs(box.y - firstRowY) < 1).length;
      expect(firstRowCount).toBeGreaterThanOrEqual(2);

      const thumbWidth = await page.locator(".grid-thumb").first().evaluate((el) => el.getBoundingClientRect().width);
      expect(thumbWidth).toBeGreaterThanOrEqual(160);
    } finally {
      await cleanup();
    }
  });
}

// ─── D4：網格密度隨容器寬度增加（padding、gap 單調遞增） ────────────────
it("D4：網格密度隨尺寸變化，.grid-view 的 padding-top 與 row-gap 在 1280<1440<2560 遞增", async () => {
  const measurements: Array<{ paddingTop: number; rowGap: number }> = [];
  for (const viewport of VIEWPORTS) {
    const { server, cleanup } = await startServerFor();
    try {
      const page = await openApp(server, viewport);
      await switchToGrid(page);
      const style = await page.locator(".grid-view").evaluate((el) => {
        const s = getComputedStyle(el);
        return { paddingTop: Number.parseFloat(s.paddingTop), rowGap: Number.parseFloat(s.rowGap) };
      });
      measurements.push(style);
    } finally {
      await cleanup();
    }
  }
  expect(measurements[0].paddingTop).toBeLessThan(measurements[1].paddingTop);
  expect(measurements[1].paddingTop).toBeLessThan(measurements[2].paddingTop);
  expect(measurements[0].rowGap).toBeLessThan(measurements[2].rowGap);
});

// ─── D5：全螢幕下 .play-bar／.view-fullscreen-bar 仍完整落在畫面內、可點擊 ─
it("D5：播放模式全螢幕下 .play-bar 完整落在螢幕內，全螢幕鈕可點擊退出", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToPlay(page);

    await page.locator(".play-bar .fullscreen-toggle-button").click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.className ?? null), { timeout: 15_000 })
      .toBe("canvas-area");

    const barBox = await boundingBoxOf(page, ".play-bar");
    expect(withinViewport(barBox, VIEWPORTS[1])).toBe(true);

    await page.locator(".play-bar .fullscreen-toggle-button").click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  } finally {
    await cleanup();
  }
});

it("D5：檢視模式全螢幕下 .view-fullscreen-bar 完整落在螢幕內、可點擊退出，且 focus-visible 生效", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);

    await page.locator('.cmd:has-text("全螢幕")').click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.className ?? null), { timeout: 15_000 })
      .toBe("canvas-area");

    const barBox = await boundingBoxOf(page, ".view-fullscreen-bar");
    expect(withinViewport(barBox, VIEWPORTS[1])).toBe(true);

    const exitButton = page.locator('.view-fullscreen-bar .fullscreen-toggle-button[aria-label="退出全螢幕"]');
    await page.keyboard.press("Tab");
    await exitButton.focus();
    const outlineStyle = await exitButton.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe("none");

    await exitButton.click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  } finally {
    await cleanup();
  }
});

// ─── E1/E2：Motion — 進場動畫時長 ≤300ms，且不延遲實際檢視切換 ─────────
it("E1：.grid-view 的 animationDuration ≤ 0.3s", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await switchToGrid(page);
    const duration = await page.locator(".grid-view").evaluate((el) => getComputedStyle(el).animationDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.3);
  } finally {
    await cleanup();
  }
});

it("E2：切到網格檢視不被動畫延遲——點下後立即 aria-pressed=true 且 .grid-view 已在 DOM", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await page.locator('.view-btn[data-view="grid"]').click();
    // 不等待動畫結束，立刻量——真正切換的訊號（DOM 掛載、aria-pressed）不應該等動畫。
    expect(await page.locator(".grid-view").count()).toBe(1);
    expect(await page.locator('.view-btn[data-view="grid"]').getAttribute("aria-pressed")).toBe("true");
  } finally {
    await cleanup();
  }
});

// ─── F1/F2/F3：prefers-reduced-motion 下仍可辨認目前檢視/投影片位置/載入/錯誤 ─
it("F1：reduced-motion 下 .grid-view 的動畫時長趨近 0，且內容立即可讀", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS[1], reducedMotion: "reduce" });
    const page = await context.newPage();
    openPages.push(page);
    await page.goto(server.url);
    const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
    await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

    await switchToGrid(page);
    const duration = await page.locator(".grid-view").evaluate((el) => getComputedStyle(el).animationDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
    const opacity = await page.locator(".grid-view").evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe("1");

    await context.close();
  } finally {
    await cleanup();
  }
});

it("F2：reduced-motion 下網格目前投影片仍可辨認（aria-current、字重、accent 外框）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS[1], reducedMotion: "reduce" });
    const page = await context.newPage();
    openPages.push(page);
    await page.goto(server.url);
    const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
    await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

    await switchToGrid(page);
    const current = page.locator('figure.grid-cell[aria-current="true"]');
    expect(await current.count()).toBe(1);
    const weight = await current.locator(".grid-number").evaluate((el) => getComputedStyle(el).fontWeight);
    expect(weight).toBe("500");

    const accent = await resolveToken(page, "--accent");
    const accentRgb = await resolvedRgb(page, accent);
    const outlineColor = await current.locator(".grid-thumb").evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outlineColor).toBe(accentRgb);

    await context.close();
  } finally {
    await cleanup();
  }
});

it("F3：reduced-motion 下播放頁碼、載入底色、錯誤通知都仍可見", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS[1], reducedMotion: "reduce" });
    const page = await context.newPage();
    openPages.push(page);
    await page.goto(server.url);
    const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
    await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

    await switchToPlay(page);
    const position = page.locator(".play-bar-position");
    await expect.poll(() => position.textContent()).toBe("1 / 4");

    await switchToGrid(page);
    const loadingBg = await page.locator(".grid-thumb").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(loadingBg).toBe("rgb(0, 0, 0)");

    await context.close();
  } finally {
    await cleanup();
  }
});

it("F3：reduced-motion 下播放錯誤通知仍可見，opacity 為 1", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: brokenEffectsDeckDir, prefix: "play-grid-visual-error" });
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS[1], reducedMotion: "reduce" });
    const page = await context.newPage();
    openPages.push(page);
    await page.goto(server.url);
    const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
    await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

    await page.locator('.view-btn[data-view="play"]').click();
    const errorNotice = page.locator(".player-error-notice", { hasText: "效果清單" });
    await expect.poll(() => errorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const opacity = await errorNotice.first().evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe("1");

    await context.close();
  } finally {
    await cleanup();
  }
});
