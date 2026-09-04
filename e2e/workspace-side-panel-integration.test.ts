import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp as openAppHelper, requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

/**
 * E1.T5 (NOOP-7) 整合驗證：E1.T3（編輯工作區）× E1.T4（側欄／對話框）合併後
 * 的組合行為 — 兩者共用 E1.T2 的根層 grid 契約與 E1.T1 的 token 契約，這裡驗
 * 的是「共用時仍協調」（IP-1～IP-8，見 NOOP-28 Plan §5），不是任一邊各自的
 * 行為 — 各自的行為已由 e2e/responsive-shell.test.ts 與
 * e2e/side-panel-visual.test.ts 覆蓋，不在此重複。
 *
 * 同兩者的規則：只讀真實 Chromium 版面
 * （boundingBox()/getComputedStyle()/elementFromPoint()），不讀 CSS 原始碼 —
 * 一個等價改寫不該讓這裡的斷言變紅。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/style-panel-deck");

/** The three desktop sizes the ticket's AC names explicitly. */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
];

let browser: Browser;
let openPages: Page[] = [];
let openContexts: BrowserContext[] = [];

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
  for (const context of openContexts) await context.close().catch(() => {});
  openContexts = [];
});

async function startServerFor(): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  return startServerForHelper({ deckDir, prefix: "workspace-side-panel" });
}

async function openApp(server: RunningServer, viewport: { width: number; height: number }): Promise<Page> {
  const page = await openAppHelper(browser, server, { viewport });
  openPages.push(page);
  return page;
}

async function openTemplateDialog(page: Page): Promise<void> {
  await page.locator('.tab:has-text("常用")').click();
  await page.locator('.cmd:has-text("範本")').click();
  await expect.poll(() => page.locator('[aria-label="範本管理"]').count()).toBe(1);
}

async function closeTemplateDialog(page: Page): Promise<void> {
  await page.locator(".template-dialog-close").click();
  await expect.poll(() => page.locator('[aria-label="範本管理"]').count()).toBe(0);
}

interface RegionBox {
  x: number;
  y: number;
  width: number;
  height: number;
  scrollWidth: number;
  clientWidth: number;
}

// A 0.5px tolerance keeps this from flagging sub-pixel float noise between
// two adjacent regions (e.g. `.overview`'s right edge and `.main`'s left
// edge, which are meant to touch exactly) as an "overlap" — a real overlap
// is many pixels wide, not a rounding artifact.
function overlaps(a: RegionBox, b: RegionBox, epsilon = 0.5): boolean {
  return (
    a.x < b.x + b.width - epsilon &&
    b.x < a.x + a.width - epsilon &&
    a.y < b.y + b.height - epsilon &&
    b.y < a.y + a.height - epsilon
  );
}

async function assertNeutralAncestry(page: Page, selector: string): Promise<void> {
  const count = await page.locator(selector).count();
  expect(count, `${selector} 一個都沒量到`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const offenders = await page.locator(selector).nth(index).evaluate((start) => {
      const found: string[] = [];
      let node: Element | null = start;
      while (node) {
        const style = getComputedStyle(node);
        if (style.filter !== "none") found.push(`${node.tagName}.${node.className}: filter=${style.filter}`);
        if (style.mixBlendMode !== "normal") found.push(`${node.tagName}.${node.className}: mixBlendMode=${style.mixBlendMode}`);
        if (style.backdropFilter !== "none") found.push(`${node.tagName}.${node.className}: backdropFilter=${style.backdropFilter}`);
        if (Number.parseFloat(style.opacity) !== 1) found.push(`${node.tagName}.${node.className}: opacity=${style.opacity}`);
        node = node.parentElement;
      }
      return found;
    });
    expect(offenders, `${selector}[${index}] 的祖先鏈裡有色彩相關屬性`).toEqual([]);
  }
}

// ─── IP-1／IP-2：.side-panel／.canvas-area 的實測寬度與 token 恆等式 ────────
it("IP-1/IP-2：三尺寸下 .canvas-area 寬 + --w-rail + --w-chat 恆等於 viewport 寬，.side-panel/.overview 寬與 token 一致", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      const tokens = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return {
          wRail: Number.parseFloat(root.getPropertyValue("--w-rail")),
          wChat: Number.parseFloat(root.getPropertyValue("--w-chat")),
        };
      });
      const overviewBox = await page.locator(".overview").boundingBox();
      const mainBox = await page.locator(".main").boundingBox();
      const canvasAreaBox = await page.locator(".canvas-area").boundingBox();
      const sidePanelBox = await page.locator(".side-panel").boundingBox();
      if (!overviewBox || !mainBox || !canvasAreaBox || !sidePanelBox) {
        throw new Error("量不到 .overview/.main/.canvas-area/.side-panel 的 boundingBox");
      }
      // getBoundingClientRect() always reports the border box, regardless of
      // box-sizing — `.overview`'s `border-right`/`.side-panel`'s
      // `border-left` (1px each) would otherwise make this a false failure
      // (measured 197 vs a 196 token) that has nothing to do with the
      // --w-rail/--w-chat contract itself. Subtracting the real border
      // widths gets back to the content width `width: var(--w-…)` actually
      // set, which is what this identity is about.
      const [overviewBorders, sidePanelBorders] = await Promise.all([
        page.locator(".overview").evaluate((el) => {
          const style = getComputedStyle(el);
          return Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
        }),
        page.locator(".side-panel").evaluate((el) => {
          const style = getComputedStyle(el);
          return Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
        }),
      ]);
      const overviewContentWidth = overviewBox.width - overviewBorders;
      const sidePanelContentWidth = sidePanelBox.width - sidePanelBorders;
      // eslint-disable-next-line no-console
      console.log(
        `[IP-1/IP-2] viewport=${viewport.width}x${viewport.height} overview.width=${overviewBox.width} (border=${overviewBorders}) main.width=${mainBox.width} canvas-area.width=${canvasAreaBox.width} side-panel.width=${sidePanelBox.width} (border=${sidePanelBorders}) --w-rail=${tokens.wRail} --w-chat=${tokens.wChat}`,
      );
      expect(sidePanelContentWidth).toBeCloseTo(tokens.wChat, 1);
      expect(overviewContentWidth).toBeCloseTo(tokens.wRail, 1);
      expect(canvasAreaBox.width).toBeCloseTo(mainBox.width, 1);
      expect(canvasAreaBox.width + tokens.wRail + tokens.wChat).toBeCloseTo(viewport.width, 1);
    }
  } finally {
    await cleanup();
  }
});

// ─── IP-4a：.side-panel 的新堆疊脈絡不擋住範本對話框遮罩 ───────────────────
it("IP-4a：範本對話框開啟時，backdrop 覆蓋含側欄在內的整個 viewport", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const viewport = VIEWPORTS[0];
    const page = await openApp(server, viewport);
    await openTemplateDialog(page);

    const backdropBox = await page.locator(".template-dialog-backdrop").boundingBox();
    if (!backdropBox) throw new Error("量不到 .template-dialog-backdrop 的 boundingBox");
    expect(backdropBox.x).toBeLessThanOrEqual(0);
    expect(backdropBox.y).toBeLessThanOrEqual(0);
    expect(backdropBox.x + backdropBox.width).toBeGreaterThanOrEqual(viewport.width);
    expect(backdropBox.y + backdropBox.height).toBeGreaterThanOrEqual(viewport.height);

    const sidePanelBox = await page.locator(".side-panel").boundingBox();
    if (!sidePanelBox) throw new Error("量不到 .side-panel 的 boundingBox");
    const centerX = sidePanelBox.x + sidePanelBox.width / 2;
    const centerY = sidePanelBox.y + sidePanelBox.height / 2;
    const hitClass = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.className ?? null,
      [centerX, centerY],
    );
    expect(hitClass).toBe("template-dialog-backdrop");
  } finally {
    await cleanup();
  }
});

// ─── IP-4b：若 ribbon 下拉選單與側欄有水平重疊，重疊處要命中選單本身 ───────
it("IP-4b：ribbon 下拉選單若與側欄有水平重疊，重疊處命中選單而非選單之下的內容", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    let anyOverlapChecked = false;
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      await page.locator('.tab:has-text("常用")').click();
      await page.locator('.cmd:has-text("排列")').click();
      await expect.poll(() => page.locator(".ribbon-menu").count()).toBe(1);

      const menuBox = await page.locator(".ribbon-menu").boundingBox();
      const sidePanelBox = await page.locator(".side-panel").boundingBox();
      if (!menuBox || !sidePanelBox) throw new Error("量不到 .ribbon-menu 或 .side-panel 的 boundingBox");

      const overlapLeft = Math.max(menuBox.x, sidePanelBox.x);
      const overlapRight = Math.min(menuBox.x + menuBox.width, sidePanelBox.x + sidePanelBox.width);
      const hasOverlap = overlapRight > overlapLeft;
      // eslint-disable-next-line no-console
      console.log(
        `[IP-4b] viewport=${viewport.width}x${viewport.height} menu.x=${menuBox.x} menu.right=${menuBox.x + menuBox.width} side-panel.x=${sidePanelBox.x} overlap=${hasOverlap}`,
      );
      if (hasOverlap) {
        anyOverlapChecked = true;
        const midX = (overlapLeft + overlapRight) / 2;
        const midY = menuBox.y + menuBox.height / 2;
        const hitsMenu = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x, y)?.closest(".ribbon-menu") !== null,
          [midX, midY],
        );
        expect(hitsMenu, `viewport=${viewport.width}x${viewport.height} 重疊處沒有命中 .ribbon-menu`).toBe(true);
      }
    }
    if (!anyOverlapChecked) {
      // eslint-disable-next-line no-console
      console.log(
        "[IP-4b] 三個支援尺寸下 .ribbon-menu 都沒有跟 .side-panel 產生水平重疊——這個互動場景在目前 ribbon 版面下不會發生（見交付留言）。",
      );
    }
  } finally {
    await cleanup();
  }
});

// ─── IP-5：reduced-motion 下，兩區共用的 motion token 同時被壓平 ───────────
// `.chat-working::before`'s `animationIterationCount` is deliberately not
// exercised here through a real chat turn — see this file's delivery
// comment on NOOP-7/NOOP-38: `editing-fake-acp-agent.mjs`'s default flow
// never emits an intermediate `tool_call` sessionUpdate, only one atomic
// `agent_message_chunk` right before `chat-done`, so `working` flips
// true→false inside the same tick and `.chat-working` never reaches a
// paintable "visible" state (confirmed on CI: 30s timeout, zero
// visibility) — not a timing flake, a structural gap in this shared
// fixture. Source-level coverage of that rule already exists (tokens.css's
// `*` reduced-motion safety net caps every `animation-iteration-count` to
// 1, and IP-5 below proves the same token layer against two *other*
// elements that don't need a chat turn to reach).
it("IP-5：prefers-reduced-motion 下，.overview-item／.side-panel-tabpanel 的動畫／transition 同時被壓平", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    openContexts.push(context);
    const page = await context.newPage();
    openPages.push(page);
    await page.goto(server.url);
    const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
    await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

    const overviewItemDuration = await page
      .locator(".overview-item")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);

    await page.locator('.side-panel-tab[data-tab="style"]').click();
    await expect.poll(() => page.locator(".style-panel").count()).toBe(1);
    const tabpanelDuration = await page.locator(".side-panel-tabpanel").evaluate((el) => getComputedStyle(el).animationDuration);

    // eslint-disable-next-line no-console
    console.log(
      `[IP-5] overview-item.transitionDuration=${overviewItemDuration} side-panel-tabpanel.animationDuration=${tabpanelDuration}`,
    );
    expect(Number.parseFloat(overviewItemDuration)).toBeLessThanOrEqual(0.001);
    expect(Number.parseFloat(tabpanelDuration)).toBeLessThanOrEqual(0.001);
  } finally {
    await cleanup();
  }
});

// ─── IP-6a：切換對話／樣式分頁不得動到舞台任何一個像素 ─────────────────────
it("IP-6a：切換對話／樣式分頁時，.stage 的截圖位元組完全相同", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    const stage = page.locator(".stage");
    const chatShot = await stage.screenshot({ animations: "disabled", caret: "hide", scale: "css" });

    await page.locator('.side-panel-tab[data-tab="style"]').click();
    await expect.poll(() => page.locator(".style-panel").count()).toBe(1);
    const styleShot = await stage.screenshot({ animations: "disabled", caret: "hide", scale: "css" });

    // eslint-disable-next-line no-console
    console.log(
      `[IP-6a] chatShot bytes=${chatShot.length} sha256=${createHash("sha256").update(chatShot).digest("hex")} styleShot bytes=${styleShot.length} sha256=${createHash("sha256").update(styleShot).digest("hex")}`,
    );
    expect(Buffer.compare(chatShot, styleShot)).toBe(0);
  } finally {
    await cleanup();
  }
});

// ─── IP-6b：投影片／縮圖／網格三種 iframe 的祖先鏈上沒有改色的屬性 ──────────
it("IP-6b：.slide-frame／.overview-frame／.grid-frame 的祖先鏈上沒有 filter／mix-blend-mode／backdrop-filter／opacity<1", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await assertNeutralAncestry(page, "iframe.slide-frame");
    await assertNeutralAncestry(page, "iframe.overview-frame");

    await page.locator('.view-btn[data-view="grid"]').click();
    await expect.poll(() => page.locator(".grid-view").count()).toBe(1);
    // `iframe.grid-frame`'s own materialisation is asynchronous relative to
    // `.grid-view`'s (e2e/grid-view.test.ts's own header note) — poll for it
    // separately rather than assuming it's already there.
    await expect.poll(() => page.locator("iframe.grid-frame").count()).toBeGreaterThan(0);
    await assertNeutralAncestry(page, "iframe.grid-frame");
  } finally {
    await cleanup();
  }
});

// ─── IP-7：三尺寸 × 三側欄狀態 × 兩檢視模式，無版面重疊、無水平捲軸 ────────
const SIDE_PANEL_STATES = ["chat", "style", "template"] as const;
const VIEW_MODES = ["normal", "grid"] as const;

async function applySidePanelState(page: Page, state: (typeof SIDE_PANEL_STATES)[number]): Promise<void> {
  if (state === "chat") {
    await page.locator('.side-panel-tab[data-tab="chat"]').click();
  } else if (state === "style") {
    await page.locator('.side-panel-tab[data-tab="style"]').click();
    await expect.poll(() => page.locator(".style-panel").count()).toBe(1);
  } else {
    await openTemplateDialog(page);
  }
}

async function resetSidePanelState(page: Page, state: (typeof SIDE_PANEL_STATES)[number]): Promise<void> {
  if (state === "template") await closeTemplateDialog(page);
}

async function applyViewMode(page: Page, mode: (typeof VIEW_MODES)[number]): Promise<void> {
  await page.locator(`.view-btn[data-view="${mode}"]`).click();
  if (mode === "grid") await expect.poll(() => page.locator(".grid-view").count()).toBe(1);
  else await expect.poll(() => page.locator(".grid-view").count()).toBe(0);
}

it("IP-7：三尺寸 × 三側欄狀態 × 兩檢視模式共 18 組，無版面重疊、無頁面級／區域級水平捲軸", async () => {
  const results: string[] = [];
  for (const viewport of VIEWPORTS) {
    const { server, cleanup } = await startServerFor();
    try {
      const page = await openApp(server, viewport);
      for (const mode of VIEW_MODES) {
        await applyViewMode(page, mode);
        for (const state of SIDE_PANEL_STATES) {
          await applySidePanelState(page, state);

          const measurement = await page.evaluate(() => {
            function box(selector: string) {
              const el = document.querySelector(selector);
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
              };
            }
            return {
              docScrollWidth: document.documentElement.scrollWidth,
              docClientWidth: document.documentElement.clientWidth,
              overview: box(".overview"),
              main: box(".main"),
              sidePanel: box(".side-panel"),
            };
          });

          const label = `viewport=${viewport.width}x${viewport.height} mode=${mode} state=${state}`;
          const { overview, main, sidePanel } = measurement;
          if (!overview || !main || !sidePanel) throw new Error(`${label}：量不到 .overview/.main/.side-panel 的 boundingBox`);

          expect(overlaps(overview, main), `${label}：.overview 與 .main 重疊`).toBe(false);
          expect(overlaps(overview, sidePanel), `${label}：.overview 與 .side-panel 重疊`).toBe(false);
          expect(overlaps(main, sidePanel), `${label}：.main 與 .side-panel 重疊`).toBe(false);

          expect(measurement.docScrollWidth, `${label}：document 有水平捲軸`).toBeLessThanOrEqual(measurement.docClientWidth);
          for (const [regionLabel, region] of [
            ["overview", overview],
            ["main", main],
            ["side-panel", sidePanel],
          ] as const) {
            expect(region.scrollWidth, `${label}：${regionLabel} 有水平捲軸`).toBeLessThanOrEqual(region.clientWidth + 1);
          }

          results.push(`${label}: PASS`);
          await resetSidePanelState(page, state);
        }
      }
    } finally {
      await cleanup();
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[IP-7] ${results.length} 組全部 PASS:\n${results.join("\n")}`);
  expect(results.length).toBe(VIEWPORTS.length * VIEW_MODES.length * SIDE_PANEL_STATES.length);
});

// ─── IP-8a：側欄取得鍵盤焦點、縮圖軌被 hover，彼此視覺互不污染 ─────────────
it("IP-8a：側欄取得鍵盤焦點不影響縮圖軌的 boxShadow／目前投影片外框；hover 縮圖軌不影響側欄選中頁籤的樣式", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { width: 1440, height: 900 });

    const overviewThumb = page.locator(".overview-item").first().locator(".overview-thumb");
    const currentThumb = page.locator(".overview-item-current .overview-thumb");
    const outlineColorBeforeFocus = await currentThumb.evaluate((el) => getComputedStyle(el).outlineColor);

    // A real Tab keypress first flips Chromium's page-global :focus-visible
    // input-modality flag to "keyboard" (it is not per-element — the same
    // pitfall e2e/side-panel-visual.test.ts's V4 documents), then .focus()
    // the actual target so the assertion below reflects real keyboard focus.
    await page.keyboard.press("Tab");
    await page.locator('.side-panel-tab[data-tab="chat"]').focus();

    expect(await overviewThumb.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    expect(await currentThumb.evaluate((el) => getComputedStyle(el).outlineColor)).toBe(outlineColorBeforeFocus);

    const selectedTab = page.locator('.side-panel-tab[aria-selected="true"]');
    const beforeHover = await selectedTab.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, borderBottomColor: style.borderBottomColor, fontWeight: style.fontWeight };
    });

    await page.locator(".overview-item").first().hover();

    const afterHover = await selectedTab.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, borderBottomColor: style.borderBottomColor, fontWeight: style.fontWeight };
    });
    expect(afterHover).toEqual(beforeHover);
  } finally {
    await cleanup();
  }
});

// ─── IP-8b：disabled 欄位共用同一個 --ink-faint token 是刻意的，不是干擾 ───
it("IP-8b：群組選取時 .style-field 的 disabled 顏色與狀態列 .slide-nav-button 的 disabled 顏色相同（共用 --ink-faint，刻意共用）", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { width: 1440, height: 900 });
    await page.locator('.side-panel-tab[data-tab="style"]').click();
    // style-panel-deck 只有一張投影片，狀態列的上一張／下一張按鈕天生 disabled，
    // 不需要額外操作；`#el-group` 是唯一的群組元素，選取它讓 hasGroup 為
    // true，StylePanel 的八個欄位才會全部進入 disabled 狀態（見
    // packages/web/src/shell/StylePanel.tsx；無選取時面板只顯示
    // .style-panel-empty 佔位文字，沒有任何 .style-field，計畫 §5.2 原文
    // 「無選取時」對不上程式碼實況，這裡改用「群組選取」讓斷言站得住腳，
    // 詳見交付留言）。
    await page.frameLocator("iframe.slide-frame").locator("#el-group").click();
    await expect.poll(() => page.locator(".style-field input:disabled").count()).toBeGreaterThan(0);
    expect(await page.locator(".slide-nav-button:disabled").count()).toBeGreaterThan(0);

    const styleFieldColor = await page.locator(".style-field input:disabled").first().evaluate((el) => getComputedStyle(el).color);
    const navButtonColor = await page.locator(".slide-nav-button:disabled").first().evaluate((el) => getComputedStyle(el).color);
    expect(styleFieldColor).toBe(navButtonColor);
  } finally {
    await cleanup();
  }
});
