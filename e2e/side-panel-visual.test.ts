import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { CommandRegistry } from "@co-motion/cli";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp as openAppHelper, requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

/**
 * 側欄與對話框視覺更新 (E1.T4/#183). Behavioural coverage only — no
 * appearance baselines here (see AGENTS.md「視覺回歸的把關分工」and this
 * PR's body: the 1440×900 baseline is expected to go stale and can only be
 * re-produced by a human triggering `.github/workflows/e2e.yml` with
 * `update_baselines`). Every assertion below reads real Chromium layout
 * (boundingBox()/getComputedStyle()), the same rule
 * e2e/responsive-shell.test.ts's header states — a CSS selector or
 * property can be rewritten to an equivalent form without the rendered box
 * model changing, and that rewrite shouldn't fail this file. The one
 * exception — literal colour/duration/easing values in source text — is a
 * source-text assertion and lives in
 * packages/web/test/side-panel-css-tokens.test.ts instead, not here.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/style-panel-deck");

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

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  return startServerForHelper({ deckDir, prefix: "side-panel-visual" });
}

async function openApp(server: RunningServer, viewport: { width: number; height: number }): Promise<Page> {
  const page = await openAppHelper(browser, server, { viewport });
  openPages.push(page);
  return page;
}

async function openStyleTabWithSelection(page: Page): Promise<void> {
  await page.locator('.side-panel-tab[data-tab="style"]').click();
  await page.frameLocator("iframe.slide-frame").locator("#el-a").click();
  await expect.poll(() => page.locator('.style-field[data-attr="fill"] input').count()).toBe(1);
}

async function openTemplateDialog(page: Page): Promise<void> {
  await page.locator('.tab:has-text("常用")').click();
  await page.locator('.cmd:has-text("範本")').click();
  await expect.poll(() => page.locator('[aria-label="範本管理"]').count()).toBe(1);
}

async function addTemplates(registry: CommandRegistry, presentationId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const result = await registry.dispatch("template add", {
      id: presentationId,
      from: "slides/001.svg",
      name: `範本 ${index + 1}`,
    });
    if (!result.ok) throw new Error(result.message);
  }
}

/** Resolves a `--token` from `:root` to its literal CSS text (e.g. `#c41e3a`, `rgba(0, 0, 0, 0.5)`). */
async function resolveToken(page: Page, name: string): Promise<string> {
  return page.evaluate((tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(), name);
}

/** Same probe-span technique as e2e/responsive-shell.test.ts's A6 — the only reliable way to compare an
 * arbitrary CSS colour string (`#hex`, `rgba(...)`, a token's raw text) against a `getComputedStyle().color`
 * result, which the browser always normalises to `rgb(...)`/`rgba(...)`. */
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

async function boxOf(page: Page, selector: string): Promise<{ width: number; height: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} 沒有 boundingBox（不在畫面上或未渲染）`);
  return { width: box.width, height: box.height };
}

// ─── V1／V3／V4：三個正式尺寸下無版面溢出、點擊區 ≥28×28、focus-visible 正確 ─
for (const viewport of VIEWPORTS) {
  it(`V1/V3/V4：${viewport.width}×${viewport.height} 下側欄無版面溢出、點擊區與 focus-visible 外框正確`, async () => {
    const { server, cleanup } = await startServerFor();
    try {
      const page = await openApp(server, viewport);
      await openStyleTabWithSelection(page);

      // V1：不產生頁面級或面板級水平捲軸。
      const docOverflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(docOverflow.scrollW).toBeLessThanOrEqual(docOverflow.clientW);

      for (const selector of [".side-panel", ".side-panel-tabpanel", ".style-panel"]) {
        const overflow = await page.locator(selector).evaluate((el) => ({
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        }));
        expect(overflow.scrollW, selector).toBeLessThanOrEqual(overflow.clientW + 1);
      }

      // V3：頁籤、樣式欄位的點擊區至少 28×28。
      const tabBox = await boxOf(page, '.side-panel-tab[data-tab="style"]');
      expect(tabBox.width).toBeGreaterThanOrEqual(28);
      expect(tabBox.height).toBeGreaterThanOrEqual(28);

      const fillInputBox = await boxOf(page, '.style-field[data-attr="fill"] input');
      expect(fillInputBox.height).toBeGreaterThanOrEqual(28);

      // V4：頁籤鍵盤取得焦點時顯示 focus-visible 外框，顏色沿用 --focus-ring。
      // Chromium 的 :focus-visible 啟發式是整頁一個「上一次輸入模態」旗標，不是
      // 逐元素的——上面 openStyleTabWithSelection 已經點過滑鼠，旗標停在
      // "pointer"，之後不管對哪個元素呼叫幾次 .focus() 都會是 focus-visible:
      // false（實測驗證過）。要讓它變回 "keyboard"，得先有一次真的鍵盤事件；
      // Tab 落在哪個元素不重要，重要的是它把模態旗標翻回鍵盤。
      const styleTab = page.locator('.side-panel-tab[data-tab="style"]');
      await page.keyboard.press("Tab");
      await styleTab.focus();
      const outlineStyle = await styleTab.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outlineStyle).not.toBe("none");
      const focusRing = await resolveToken(page, "--focus-ring");
      const focusRingRgb = await resolvedRgb(page, focusRing);
      const outlineColor = await styleTab.evaluate((el) => getComputedStyle(el).outlineColor);
      expect(outlineColor).toBe(focusRingRgb);
    } finally {
      await cleanup();
    }
  });
}

// ─── V1（切到對話分頁，聊天輸入區）／V3（送出鈕、輸入框）────────────────────
it("V1/V3：對話分頁下輸入區無溢出，輸入框與送出鈕點擊區 ≥28×28", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);

    const overflow = await page.locator(".chat-sidebar").evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    }));
    expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW + 1);

    const inputBox = await boxOf(page, ".chat-input input");
    expect(inputBox.height).toBeGreaterThanOrEqual(28);
    const buttonBox = await boxOf(page, ".chat-input button");
    expect(buttonBox.width).toBeGreaterThanOrEqual(28);
    expect(buttonBox.height).toBeGreaterThanOrEqual(28);

    await page.locator(".chat-input input").focus();
    const outlineStyle = await page.locator(".chat-input input").evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe("none");
  } finally {
    await cleanup();
  }
});

// ─── V2／V1／V3／V4／V8：範本對話框——只有清單捲動，按鈕點擊區、關閉鈕 tooltip、focus-visible ─
it("V1/V2/V3/V4/V8：範本對話框內容過多時只有清單捲動，按鈕與關閉鈕符合尺寸／tooltip／focus-visible", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await addTemplates(registry, presentationId, 15);
    const page = await openApp(server, VIEWPORTS[0]);
    await openTemplateDialog(page);

    // V2：清單本身會捲動，但外層 .template-dialog 不捲。
    const listOverflow = await page.locator(".template-dialog-list").evaluate((el) => ({
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
    }));
    expect(listOverflow.scrollH).toBeGreaterThan(listOverflow.clientH);

    const dialogOverflow = await page.locator(".template-dialog").evaluate((el) => ({
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
    }));
    expect(dialogOverflow.scrollH).toBeLessThanOrEqual(dialogOverflow.clientH + 1);

    // 標題列在清單捲動後仍然看得到（不隨清單一起被捲走）——這個檔案的 expect
    // 來自 "vitest"，不是 "@playwright/test"，沒有 toBeInViewport 這個 matcher
    // 可用，所以直接讀標題列相對頁面 viewport 的座標，核對它落在可視範圍內。
    const viewportSize = page.viewportSize();
    if (!viewportSize) throw new Error("page 沒有 viewport");
    const header = page.locator(".template-dialog-header").first();
    const headerBox = await header.boundingBox();
    if (!headerBox) throw new Error(".template-dialog-header 沒有 boundingBox");
    expect(headerBox.y).toBeGreaterThanOrEqual(0);
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(viewportSize.height);

    // V1：對話框本身不產生水平溢出。
    const hOverflow = await page.locator(".template-dialog").evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    }));
    expect(hOverflow.scrollW).toBeLessThanOrEqual(hOverflow.clientW + 1);

    // V3：每個按鈕（含關閉鈕）點擊區至少 28×28。
    const closeBox = await boxOf(page, ".template-dialog-close");
    expect(closeBox.width).toBeGreaterThanOrEqual(28);
    expect(closeBox.height).toBeGreaterThanOrEqual(28);
    const firstItemButtonBox = await boxOf(page, '.template-dialog-item button:has-text("改名")');
    expect(firstItemButtonBox.width).toBeGreaterThanOrEqual(28);
    expect(firstItemButtonBox.height).toBeGreaterThanOrEqual(28);

    // V4：關閉鈕 focus-visible 外框顏色沿用 --focus-ring。上面已經點過 ribbon
    // 按鈕，頁面的輸入模態旗標停在 pointer——見 V1/V3/V4 那個 it() 裡的註解，
    // 先按一次 Tab 把模態翻回 keyboard，.focus() 才會顯示 focus-visible。
    const closeButton = page.locator(".template-dialog-close");
    await page.keyboard.press("Tab");
    await closeButton.focus();
    const outlineStyle = await closeButton.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe("none");
    const focusRing = await resolveToken(page, "--focus-ring");
    const focusRingRgb = await resolvedRgb(page, focusRing);
    const outlineColor = await closeButton.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outlineColor).toBe(focusRingRgb);

    // V8：純圖示的關閉鈕同時具備非空 title 與 aria-label。
    expect(await closeButton.getAttribute("title")).toBeTruthy();
    expect(await closeButton.getAttribute("aria-label")).toBeTruthy();
  } finally {
    await cleanup();
  }
});

// ─── V6：範本對話框錯誤訊息顏色是 --ink，不是 --accent-hi ────────────────
it("V6：範本刪除失敗時，錯誤訊息文字色是 --ink（不是 --accent-hi）", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const added = await registry.dispatch<{ templatePath: string }>("template add", {
      id: presentationId,
      from: "slides/001.svg",
      name: "V6 測試範本",
    });
    if (!added.ok) throw new Error(added.message);

    const page = await openApp(server, VIEWPORTS[1]);
    await page.route("**/api/command", async (route) => {
      const body = route.request().postDataJSON() as { name?: string };
      if (body.name === "template delete") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "刪除失敗（測試注入）" }),
        });
        return;
      }
      await route.continue();
    });

    await openTemplateDialog(page);
    const item = page.locator(".template-dialog-item");
    await item.getByRole("button", { name: "刪除" }).click();
    await item.getByRole("button", { name: "確定刪除" }).click();

    const alert = item.locator('[role="alert"]');
    await expect.poll(() => alert.textContent().catch(() => null)).toBe("刪除失敗（測試注入）");

    const ink = await resolveToken(page, "--ink");
    const inkRgb = await resolvedRgb(page, ink);
    const errorColor = await alert.evaluate((el) => getComputedStyle(el).color);
    expect(errorColor).toBe(inkRgb);
  } finally {
    await cleanup();
  }
});

// ─── V7：對話框遮罩使用 --s-scrim ────────────────────────────────────
it("V7：範本對話框遮罩背景色等於 --s-scrim 的解析值", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await addTemplates(registry, presentationId, 1);
    const page = await openApp(server, VIEWPORTS[1]);
    await openTemplateDialog(page);

    const scrim = await resolveToken(page, "--s-scrim");
    const scrimRgb = await resolvedRgb(page, scrim);
    const backdropColor = await page
      .locator(".template-dialog-backdrop")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(backdropColor).toBe(scrimRgb);
  } finally {
    await cleanup();
  }
});

// ─── V5：四個命令狀態的 border-left-style 兩兩不同（不只靠顏色分辨）───────
it("V5：pending/in_progress/completed/failed 四個命令狀態的 border-left-style 彼此不同", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, VIEWPORTS[1]);

    const styles = await page.evaluate(() => {
      const statuses = ["pending", "in_progress", "completed", "failed"];
      const container = document.querySelector(".chat-messages");
      if (!container) throw new Error(".chat-messages 不存在");
      return statuses.map((status) => {
        const el = document.createElement("div");
        el.className = `chat-command chat-command-${status}`;
        container.appendChild(el);
        const style = getComputedStyle(el).borderLeftStyle;
        el.remove();
        return style;
      });
    });

    expect(new Set(styles).size).toBe(styles.length);
  } finally {
    await cleanup();
  }
});

// ─── V9：prefers-reduced-motion 下側欄分頁切換沒有可感知的動畫延遲 ────────
it("V9：prefers-reduced-motion 時，分頁切換的進場動畫時長趨近 0 且內容立即可讀", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS[1], reducedMotion: "reduce" });
    const page = await context.newPage();
    openPages.push(page);
    await page.goto(server.url);
    const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
    await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

    await page.locator('.side-panel-tab[data-tab="style"]').click();
    await expect.poll(() => page.locator(".style-panel").count()).toBe(1);

    const duration = await page.locator(".side-panel-tabpanel").evaluate((el) => getComputedStyle(el).animationDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);

    const opacity = await page.locator(".style-panel").evaluate((el) => getComputedStyle(el.parentElement!).opacity);
    expect(opacity).toBe("1");

    await context.close();
  } finally {
    await cleanup();
  }
});
