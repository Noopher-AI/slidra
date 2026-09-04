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

/**
 * Responsive-shell behavioural coverage (NOOP-4 E1.T2). Deliberately a new
 * file, not an extension of e2e/shell.test.ts — that file's three baseline
 * screenshots are frozen against a fixed 1440×900 viewport and are not
 * meant to be parameterised over viewport size.
 *
 * No appearance baselines here. Every assertion reads real Chromium layout
 * (boundingBox()/getComputedStyle()), never CSS source text — a CSS
 * selector or property can be rewritten to an equivalent form without the
 * rendered box model changing, and that rewrite shouldn't fail this file.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const binDir = path.join(rootDir, "node_modules/.bin");

/** The three desktop sizes the ticket's AC names explicitly. */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
];

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
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-responsive-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-responsive-files-"));
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

/** Loads the app at a given viewport and waits for the first slide + chat stream. */
async function openApp(server: RunningServer, viewport: { width: number; height: number }): Promise<Page> {
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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxesOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

interface ChromeMetrics {
  titlebarHeight: number;
  tabsHeight: number;
  groupsHeight: number;
  statusHeight: number;
  deckNameFontSize: string;
  slideNavPositionFontSize: string;
  cmdLabelFontSize: string;
  tabFontSize: string;
  canvasArea: { width: number; height: number };
}

async function readChromeMetrics(page: Page): Promise<ChromeMetrics> {
  await page.locator('.tab:has-text("常用")').click();
  const titlebar = await page.locator(".titlebar").boundingBox();
  const tabs = await page.locator(".tabs").boundingBox();
  const groups = await page.locator(".groups").boundingBox();
  const status = await page.locator(".status").boundingBox();
  const canvasArea = await page.locator(".canvas-area").boundingBox();
  if (!titlebar || !tabs || !groups || !status || !canvasArea) {
    throw new Error("量不到 chrome 區塊的 boundingBox");
  }
  const fontSize = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontSize);
  return {
    titlebarHeight: titlebar.height,
    tabsHeight: tabs.height,
    groupsHeight: groups.height,
    statusHeight: status.height,
    deckNameFontSize: await fontSize(".deck-name"),
    slideNavPositionFontSize: await fontSize(".slide-nav-position"),
    cmdLabelFontSize: await fontSize(".cmd span"),
    tabFontSize: await fontSize(".tab"),
    canvasArea: { width: canvasArea.width, height: canvasArea.height },
  };
}

// ─── A1/A2：不整體縮放、多出的空間全部進主區域、無捲軸 ──────────────

it("A1/A2：三個支援尺寸下 chrome 高度與字級不變，canvas-area 嚴格遞增，無頁面級／區域級捲軸", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const metrics: ChromeMetrics[] = [];
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      metrics.push(await readChromeMetrics(page));

      const overflow = await page.evaluate(() => ({
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        docScrollH: document.documentElement.scrollHeight,
        docClientH: document.documentElement.clientHeight,
        bodyScrollW: document.body.scrollWidth,
        bodyClientW: document.body.clientWidth,
      }));
      expect(overflow.docScrollW).toBeLessThanOrEqual(overflow.docClientW);
      expect(overflow.docScrollH).toBeLessThanOrEqual(overflow.docClientH);
      expect(overflow.bodyScrollW).toBeLessThanOrEqual(overflow.bodyClientW);

      for (const selector of [".ribbon", ".groups", ".tabs", ".status", ".titlebar"]) {
        const region = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        }, selector);
        expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
      }
    }

    const [v1280, v1440, v2560] = metrics;

    for (const key of ["titlebarHeight", "tabsHeight", "groupsHeight", "statusHeight"] as const) {
      expect(v1440[key]).toBe(v1280[key]);
      expect(v2560[key]).toBe(v1280[key]);
    }
    for (const key of ["deckNameFontSize", "slideNavPositionFontSize", "cmdLabelFontSize", "tabFontSize"] as const) {
      expect(v1440[key]).toBe(v1280[key]);
      expect(v2560[key]).toBe(v1280[key]);
    }

    expect(v1440.canvasArea.width).toBeGreaterThan(v1280.canvasArea.width);
    expect(v1440.canvasArea.height).toBeGreaterThan(v1280.canvasArea.height);
    expect(v2560.canvasArea.width).toBeGreaterThan(v1440.canvasArea.width);
    expect(v2560.canvasArea.height).toBeGreaterThan(v1440.canvasArea.height);
  } finally {
    await cleanup();
  }
});

// ─── A3/A4/A7：點擊區尺寸、無重疊、下拉選單堆疊 ──────────────────────

it("A3/A4/A7：所有互動控制項點擊區 ≥28×28（密集群組 ≥24×24），chrome 區塊互不重疊，下拉選單畫在舞台之上", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      await page.locator('.tab:has-text("常用")').click();

      const cmdBoxes = await page
        .locator(".groups .cmd")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map(({ width, height }) => ({ width, height })));
      for (const box of cmdBoxes) {
        expect(box.width).toBeGreaterThanOrEqual(28);
        expect(box.height).toBeGreaterThanOrEqual(28);
      }

      const tabHeights = await page.locator('.tabs [role="tab"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      for (const height of tabHeights) {
        expect(height).toBeGreaterThanOrEqual(28);
      }

      const viewBtnBoxes = await page
        .locator(".views .view-btn")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map(({ width, height }) => ({ width, height })));
      expect(viewBtnBoxes.length).toBeGreaterThan(0);
      for (const box of viewBtnBoxes) {
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
      }

      const navBoxes = await page
        .locator(".slide-nav-button")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map(({ width, height }) => ({ width, height })));
      expect(navBoxes.length).toBeGreaterThan(0);
      for (const box of navBoxes) {
        expect(box.width).toBeGreaterThanOrEqual(28);
        expect(box.height).toBeGreaterThanOrEqual(28);
      }

      // 開一個下拉才量得到 .ribbon-menu-item，同時驗證 A7（不被舞台蓋住）
      await page.locator('.cmd:has-text("新增投影片")').click();
      const menuItemHeights = await page.locator(".ribbon-menu-item").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      expect(menuItemHeights.length).toBeGreaterThan(0);
      for (const height of menuItemHeights) {
        expect(height).toBeGreaterThanOrEqual(28);
      }

      const menuBox = await page.locator(".ribbon-menu").boundingBox();
      if (!menuBox) throw new Error("量不到 .ribbon-menu 的 boundingBox");
      const isInsideMenu = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest(".ribbon-menu") !== null,
        { x: menuBox.x + menuBox.width / 2, y: menuBox.y + menuBox.height / 2 },
      );
      expect(isInsideMenu).toBe(true);
      await page.keyboard.press("Escape");

      // A4：五個具名 grid area 互不重疊
      const regionSelectors = [".titlebar", ".ribbon", ".app-notices", ".body", ".status"];
      const regionBoxes: Rect[] = [];
      for (const selector of regionSelectors) {
        const box = await page.locator(selector).boundingBox();
        if (box) regionBoxes.push(box);
      }
      for (let i = 0; i < regionBoxes.length; i++) {
        for (let j = i + 1; j < regionBoxes.length; j++) {
          expect(boxesOverlap(regionBoxes[i], regionBoxes[j])).toBe(false);
        }
      }

      // .groups 內相鄰兩顆 .cmd 不重疊
      const cmdRects: Rect[] = await page.locator(".groups .cmd").evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      for (let i = 0; i < cmdRects.length - 1; i++) {
        expect(boxesOverlap(cmdRects[i], cmdRects[i + 1])).toBe(false);
      }
    }
  } finally {
    await cleanup();
  }
});

// ─── A5：極端文字不撐破版面 ───────────────────────────────────────

it("A5：.sel-name 極長文字不把 .views 推出視窗，仍無頁面級捲軸", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    await page.evaluate(() => {
      const selName = document.querySelector(".status .sel-name") as HTMLElement;
      selName.innerHTML = `已選取：<b>${"極長選取名稱".repeat(40)}</b>`;
    });

    const viewport = page.viewportSize();
    const viewsBox = await page.locator(".views").boundingBox();
    if (!viewport || !viewsBox) throw new Error("量不到 .views 的 boundingBox 或 viewport");
    expect(viewsBox.x + viewsBox.width).toBeLessThanOrEqual(viewport.width);

    const navBox = await page.locator('.slide-nav-button[aria-label="下一頁"]').boundingBox();
    if (!navBox) throw new Error("量不到翻頁鈕的 boundingBox");
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(viewport.width);

    const overflow = await page.evaluate(() => ({
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    }));
    expect(overflow.docScrollW).toBeLessThanOrEqual(overflow.docClientW);
  } finally {
    await cleanup();
  }
});

// ─── A6：focus-visible ────────────────────────────────────────────

it("A6：.tab 取得鍵盤焦點時顯示 focus-visible 外框，顏色沿用 --focus-ring", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    const firstTab = page.locator(".tab").first();
    await firstTab.focus();

    const outlineStyle = await firstTab.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe("none");

    // shell.css 的 `.tab:focus-visible` 消費 `var(--focus-ring)`，不是 `--accent`
    // 本身——NOOP-9 把 `--focus-ring` 改指到 `--accent-hi`（WCAG 2.2 AA 非文字對比
    // 3:1，見該票交付說明），這裡原本寫死讀 `--accent` 就會跟著改動的 token 脫鉤。
    const focusRing = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim());
    const focusRingRgb = await page.evaluate((value) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    }, focusRing);
    const outlineColor = await firstTab.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outlineColor).toBe(focusRingRgb);
  } finally {
    await cleanup();
  }
});

// ─── E1.T3：編輯工作區（縮圖軌／舞台／備忘稿）視覺更新 ──────────────────
// 下方 it() 標題裡的 A1–A6 是本票（NOOP-22 / GitHub #184）自己的驗收清單編
// 號，與上面 E1.T2 的 A1–A7 是兩套不同的編號，只是巧合共用同一個檔案。

it("E1.T3 A1：縮圖軌／舞台／備忘稿在三個尺寸下皆無區域級水平捲軸", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      for (const selector of [".overview", ".canvas-area", ".notes"]) {
        const region = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        }, selector);
        expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
      }
    }
  } finally {
    await cleanup();
  }
});

it("E1.T3 A2：縮圖點擊區在三個尺寸下寬高皆 ≥28px", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      const thumbBoxes = await page
        .locator("button.overview-thumb")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map(({ width, height }) => ({ width, height })));
      expect(thumbBoxes.length).toBeGreaterThan(0);
      for (const box of thumbBoxes) {
        expect(box.width).toBeGreaterThanOrEqual(28);
        expect(box.height).toBeGreaterThanOrEqual(28);
      }
    }
  } finally {
    await cleanup();
  }
});

it("E1.T3 A3：目前投影片除既有的 outline 色之外，還有兩個非色彩的辨識通道", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server, VIEWPORTS[1]);

    const markerWidth = await page
      .locator("li.overview-item-current")
      .evaluate((el) => getComputedStyle(el, "::before").width);
    expect(markerWidth).not.toBe("0px");
    const markerContent = await page
      .locator("li.overview-item-current")
      .evaluate((el) => getComputedStyle(el, "::before").content);
    expect(markerContent).not.toBe("none");

    const currentWeight = await page.locator("li.overview-item-current .overview-number").evaluate((el) => getComputedStyle(el).fontWeight);
    const otherWeight = await page
      .locator("li.overview-item:not(.overview-item-current) .overview-number")
      .first()
      .evaluate((el) => getComputedStyle(el).fontWeight);
    expect(currentWeight).not.toBe(otherWeight);
  } finally {
    await cleanup();
  }
});

it("E1.T3 A4：縮圖鍵盤焦點顯示未被裁切的可見焦點框", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const page = await openApp(server, VIEWPORTS[1]);
    const firstThumb = page.locator("button.overview-thumb").first();
    await firstThumb.focus();

    const boxShadow = await firstThumb.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toBe("none");

    const itemBox = await page.locator("li.overview-item").first().boundingBox();
    const overviewBox = await page.locator(".overview").boundingBox();
    if (!itemBox || !overviewBox) throw new Error("量不到 .overview-item 或 .overview 的 boundingBox");
    expect(itemBox.x).toBeGreaterThanOrEqual(overviewBox.x);
    expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(overviewBox.x + overviewBox.width);
  } finally {
    await cleanup();
  }
});

it("E1.T3 A5：舞台在三個尺寸下維持投影片比例", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      const stageBox = await page.locator(".stage").boundingBox();
      if (!stageBox) throw new Error("量不到 .stage 的 boundingBox");
      expect(stageBox.width / stageBox.height).toBeCloseTo(1280 / 720, 1);
    }
  } finally {
    await cleanup();
  }
});

it("E1.T3 A6：舞台與縮圖軌的密度隨可用空間切換（container query 生效）", async () => {
  const { server, cleanup } = await startServerFor(demoDir);
  try {
    const paddings: number[] = [];
    const gaps: number[] = [];
    for (const viewport of VIEWPORTS) {
      const page = await openApp(server, viewport);
      const paddingLeft = await page.locator(".canvas-area").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
      const rowGap = await page.locator(".overview-list").evaluate((el) => parseFloat(getComputedStyle(el).rowGap));
      paddings.push(paddingLeft);
      gaps.push(rowGap);
    }
    const [p1280, p1440, p2560] = paddings;
    expect(p1280).toBeLessThan(p1440);
    expect(p1440).toBeLessThan(p2560);

    const [g1280, , g2560] = gaps;
    expect(g1280).toBeLessThan(g2560);
  } finally {
    await cleanup();
  }
});
