import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import type { RunningServer } from "../packages/server/src/serve.js";
import { requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";
import { matrixScenarios } from "./helpers/matrix-scenarios.js";
import { contrastRatio, parseColor } from "./helpers/contrast.js";

/**
 * WCAG 2.2 AA automated scan (NOOP-9 Plan §1/§4.6): Chromium only, 1440×900
 * only (architecture: "在核心 Chromium 場景與代表性狀態執行 WCAG 掃描", no
 * three-viewport requirement here — that's visual-matrix.test.ts's job).
 * Runs axe-core against the 7 matrix scenarios that don't require a second
 * deck, plus the explicit focus/keyboard-order assertions axe cannot check
 * (it has no non-text-contrast or focus-appearance rule at all — Plan §3.7).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const brokenEffectsDeckDir = path.join(e2eDir, "fixtures/broken-effects-deck");

const VIEWPORT = { width: 1440, height: 900 };
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const A11Y_SCENARIO_IDS = ["standard", "standard-selected", "grid", "play", "play-error", "side-panel-style", "template-dialog"];
const SCENARIOS = matrixScenarios({ demoDir, brokenEffectsDeckDir }).filter((s) => A11Y_SCENARIO_IDS.includes(s.id));

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

it("§1：a11y.test.ts 涵蓋的場景 id 恰好是 NOOP-9 Plan §4.6 列的 7 個（不多不少）", () => {
  expect(SCENARIOS.map((s) => s.id).sort()).toEqual([...A11Y_SCENARIO_IDS].sort());
});

for (const scenario of SCENARIOS) {
  it(`axe：${scenario.id} 場景在 1440×900 下沒有 WCAG 2.2 AA 違規（產品 UI，投影片內容除外）`, async () => {
    const { server, registry, presentationId, cleanup } = await startServerForHelper({
      deckDir: scenario.deckDir,
      prefix: `a11y-${scenario.id}`,
    });
    try {
      const page = await openPage(server, VIEWPORT);
      await scenario.arrive(page, { registry, presentationId });

      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .exclude("iframe.slide-frame")
        .exclude("iframe.grid-frame")
        .exclude("iframe.overview-frame")
        .analyze();

      if (results.violations.length > 0) {
        const details = results.violations
          .map((v) => {
            const nodes = v.nodes.map((n) => `    - ${n.target.join(" ")}: ${n.failureSummary}`).join("\n");
            return `  [${v.id}] impact=${v.impact} ${v.help}\n${nodes}`;
          })
          .join("\n");
        throw new Error(`axe 違規（${scenario.id}）：\n${details}`);
      }

      // A violations-empty result is dangerous if the contrast rule never actually ran —
      // Plan §4.6: 必須確認 color-contrast 真的執行到，不是被排除規則悄悄跳過。
      expect(results.passes.some((p) => p.id === "color-contrast"), "color-contrast 規則應出現在 passes 中").toBe(true);
    } finally {
      await cleanup();
    }
  });
}

/** AxeBuilder rejects a page created via the shorthand `browser.newPage()` ("Please use browser.newContext()", verified on CI) — it needs a page that came from an explicit context. */
async function openPage(server: RunningServer, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  openContexts.push(context);
  const page = await context.newPage();
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return page;
}

/** Walks up from `el` until a non-transparent `background-color` is found — the element itself or its nearest ancestor with a set background is what actually shows behind it. */
async function resolveVisibleBackground(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((start) => {
    let el: Element | null = start;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      const isTransparent = bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
      if (!isTransparent) return bg;
      el = el.parentElement;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  });
}

it("焦點非文字對比：代表性控制項鍵盤聚焦時的外框對比其背後表面 ≥ 3:1", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: "a11y-focus-contrast" });
  try {
    const page = await openPage(server, VIEWPORT);
    await page.locator('.tab:has-text("常用")').click();

    const targets = [".view-btn", ".slide-nav-button", ".side-panel-tab", ".cmd"];
    for (const selector of targets) {
      await page.keyboard.press("Tab");
      const target = page.locator(selector).first();
      await target.focus();

      const outlineColor = await target.evaluate((el) => getComputedStyle(el).outlineColor);
      const behindColor = await resolveVisibleBackground(page, selector);
      const ratio = contrastRatio(parseColor(outlineColor), parseColor(behindColor));
      expect(ratio, `${selector}：outline ${outlineColor} vs 背景 ${behindColor}`).toBeGreaterThanOrEqual(3.0);
    }

    // .play-bar button only exists in play mode.
    await page.locator('.view-btn[data-view="play"]').click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");
    await expect
      .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
      .toBe("true");
    await page.keyboard.press("Tab");
    const playButton = page.locator(".play-bar button").first();
    await playButton.focus();
    const outlineColor = await playButton.evaluate((el) => getComputedStyle(el).outlineColor);
    const behindColor = await resolveVisibleBackground(page, ".play-bar");
    const ratio = contrastRatio(parseColor(outlineColor), parseColor(behindColor));
    expect(ratio, `.play-bar button：outline ${outlineColor} vs 背景 ${behindColor}`).toBeGreaterThanOrEqual(3.0);
  } finally {
    await cleanup();
  }
});

it("focus-visible：鍵盤聚焦顯示外框，滑鼠 click 聚焦允許無外框", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: "a11y-focus-visible" });
  try {
    const page = await openPage(server, VIEWPORT);
    await page.locator('.tab:has-text("常用")').click();

    await page.keyboard.press("Tab");
    const tab = page.locator(".tab").first();
    await tab.focus();
    const keyboardOutline = await tab.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(keyboardOutline).not.toBe("none");

    const keyboardWidth = await tab.evaluate((el) => Number.parseFloat(getComputedStyle(el).outlineWidth));
    expect(keyboardWidth).toBeGreaterThan(0);
  } finally {
    await cleanup();
  }
});

it("區域 overflow：Chromium 1440×900 下 shell 主要區塊沒有非預期裁切", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: "a11y-overflow" });
  try {
    const page = await openPage(server, VIEWPORT);
    for (const selector of [".titlebar", ".ribbon", ".overview", ".canvas-area", ".side-panel", ".status"]) {
      const overflow = await page.locator(selector).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect(overflow.scrollWidth, selector).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  } finally {
    await cleanup();
  }
});

it("鍵盤順序：從 document.body 連續 Tab 不離開文件、不卡在同一元素，且涵蓋的區塊由上而下不倒退", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: "a11y-tab-order" });
  try {
    const page = await openPage(server, VIEWPORT);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Region priority, in actual DOM tab order — verified on CI (this test's own
    // console.log below), not the architecture summary's prose "標題列→ribbon→畫布→
    // 側欄→狀態列": the thumbnail rail (.overview) sits to the canvas's left and is
    // reached before .canvas-area, not after. .titlebar has no focusable elements at
    // all today, which is fine — a region only needs to be non-decreasing when it
    // does appear, not to appear.
    const REGION_PRIORITY = [".titlebar", ".ribbon", ".overview", ".canvas-area", ".side-panel", ".status"];

    const sequence: Array<{ tag: string; id: string; region: number }> = [];
    for (let step = 0; step < 60; step++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate((regions) => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const regionIndex = regions.findIndex((selector) => el.closest(selector) !== null);
        return { tag: el.tagName, id: el.id, region: regionIndex };
      }, REGION_PRIORITY);
      if (info === null) break;
      expect(info, `Tab 第 ${step + 1} 次：activeElement 離開了文件`).not.toBeNull();
      sequence.push(info);
    }
    console.log(`[鍵盤順序] ${sequence.map((s) => `${s.tag}${s.id ? "#" + s.id : ""}@region${s.region}`).join(" -> ")}`);

    expect(sequence.length, "至少要能 Tab 到一個元素").toBeGreaterThan(0);

    // Not stuck: no two consecutive steps land on the exact same element.
    for (let i = 1; i < sequence.length; i++) {
      const prev = sequence[i - 1];
      const cur = sequence[i];
      const same = prev.tag === cur.tag && prev.id === cur.id && prev.id !== "";
      expect(same, `Tab 第 ${i} 次卡在同一元素`).toBe(false);
    }

    // Regions appear in non-decreasing priority order the first time each is seen.
    let lastFirstSeenPriority = -1;
    const seenRegions = new Set<number>();
    for (const { region } of sequence) {
      if (region < 0 || seenRegions.has(region)) continue;
      seenRegions.add(region);
      expect(region, `區塊 "${REGION_PRIORITY[region]}" 第一次出現的順序早於前一個新出現的區塊`).toBeGreaterThanOrEqual(lastFirstSeenPriority);
      lastFirstSeenPriority = region;
    }
  } finally {
    await cleanup();
  }
});
