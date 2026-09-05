import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

/**
 * Cross-cutting motion-budget verification (NOOP-9 Plan §1/§4.7): duration
 * ceilings and reduced-motion behaviour checked *across* the whole shell at
 * once, rather than per-feature.
 *
 * New v3 shell rebuild (this ticket): the old ribbon/grid-view/template-
 * dialog UI this file used to exercise is gone (Ribbon.tsx, GridView.tsx,
 * TemplateDialog.tsx all deleted — see that ticket's PR report). Category
 * ceilings below now map onto the New v3 shell's own token set
 * (tokens.css's `--dur-fast` 150ms / `--dur-base` 180ms — the old three-tier
 * `--dur-micro`/`--dur-panel`/`--dur-view` naming from NOOP-9 Plan §4.7 no
 * longer exists in tokens.css, which was rewritten wholesale onto
 * 01-DESIGN_TOKENS.md's naming; see that ticket's own tokens.css file
 * header). The 300ms overall ceiling (below) and the two category ceilings
 * are still meaningful sanity checks even though the specific named tokens
 * they were once keyed to are gone: every New v3 shell animation/transition
 * in fact uses `--dur-fast` or `--dur-base`, both well under 300ms.
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

/** Splits a possibly multi-value `animation-duration`/`transition-duration` computed string (e.g. `"0.26s, 0.1s"`) into seconds, checking every value — `parseFloat` alone would silently only see the first. */
function parseAllSeconds(value: string): number[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseFloat(part));
}

interface ElementMotion {
  selector: string;
  index: number;
  animationDurations: number[];
  transitionDurations: number[];
  animationIterationCount: string;
}

/** Scans every element in the page for a non-"none" animation-name or a non-zero transition-duration, returning each one's parsed durations. */
async function scanMotion(page: Page): Promise<ElementMotion[]> {
  return page.evaluate(() => {
    const results: Array<{ selector: string; index: number; animationDurations: string; transitionDurations: string; animationIterationCount: string }> = [];
    const all = document.querySelectorAll("*");
    all.forEach((el, index) => {
      const style = getComputedStyle(el);
      const hasAnimation = style.animationName !== "none";
      const hasTransition = style.transitionDuration.split(",").some((d) => Number.parseFloat(d) > 0);
      if (!hasAnimation && !hasTransition) return;
      const selector = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : "");
      results.push({
        selector,
        index,
        animationDurations: style.animationDuration,
        transitionDurations: style.transitionDuration,
        animationIterationCount: style.animationIterationCount,
      });
    });
    return results;
  }).then((raw) =>
    raw.map((r) => ({
      selector: r.selector,
      index: r.index,
      animationDurations: parseAllSeconds(r.animationDurations),
      transitionDurations: parseAllSeconds(r.transitionDurations),
      animationIterationCount: r.animationIterationCount,
    })),
  );
}

async function openApp(page: Page, server: { url: string }): Promise<void> {
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
}

it("正常 motion 下，全站任一（非無限循環）動畫／transition 的每個 duration 值都 ≤ 0.300s（--dur-view 的上限）", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: "motion-ceiling" });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    openPages.push(page);
    await openApp(page, server);

    const motions = await scanMotion(page);
    const offenders: string[] = [];
    for (const m of motions) {
      // 持續循環的載入指示器（chat-working-spin，chat.css）不是「view
      // switch/dialog」類的一次性 motion，不受這個上限約束——它用
      // calc(var(--dur-base) * 4) 當自己的節奏，是刻意的設計決定，不是回歸。
      if (m.animationIterationCount === "infinite") continue;
      for (const d of [...m.animationDurations, ...m.transitionDurations]) {
        if (d > 0.3) offenders.push(`${m.selector}[${m.index}]: ${d}s`);
      }
    }
    expect(offenders).toEqual([]);
  } finally {
    await cleanup();
  }
});

interface CategoryCase {
  category: string;
  selector: string;
  ceiling: number;
  arrive?: (page: Page) => Promise<void>;
}

const CATEGORY_CASES: CategoryCase[] = [
  { category: "微互動（--dur-fast ≤160ms）", selector: ".dock-command", ceiling: 0.16 },
  // `.slide-nav-button` 不是這裡的好選擇：demo 牌組第一頁時「上一頁」按鈕
  // 是 disabled 狀態（40% 透明，見 shell.css 的全域 disabled 規則），reduced
  // motion 測項斷言 opacity 必須是 1，用它會誤判成違規。`.dock-hand-button`
  // 沒有停用邏輯，永遠可見/可按，是同一類「微互動」控制項裡更穩定的樣本。
  { category: "微互動（--dur-fast ≤160ms）", selector: ".dock-hand-button", ceiling: 0.16 },
  { category: "微互動（--dur-fast ≤160ms）", selector: ".side-panel-tab", ceiling: 0.16 },
  {
    category: "面板類（--dur-base ≤220ms）",
    selector: ".side-panel-tabpanel",
    ceiling: 0.22,
    arrive: async (page) => {
      await page.locator('.side-panel-tab[data-tab="style"]').click();
    },
  },
  {
    // New v3 shell's floating layers (Dock 的 Insert 面板／Shape／Arrange／
    // Zoom 選單，02-DESIGN_DOC.md §2.3「一律從同一個地方長出」) — grid-view／
    // template-dialog 已刪除（GridView.tsx／TemplateDialog.tsx 整個拿掉，
    // 見該張票的 PR 報告），`.floating-layer` 是這張骨架票唯一新增、會播放
    // 進場動畫的浮層 class（`floating-layer-in`，用 --dur-fast）。用縮放選
    // 單（唯一整個可用的浮層）進場來量測。
    category: "浮層類（--dur-fast ≤300ms，取代已刪除的 .grid-view／.template-dialog）",
    selector: ".floating-layer",
    ceiling: 0.3,
    arrive: async (page) => {
      await page.locator(".dock-zoom-control").click();
      await expect.poll(() => page.locator(".floating-layer").count()).toBe(1);
    },
  },
];

for (const testCase of CATEGORY_CASES) {
  it(`${testCase.category}：${testCase.selector} 的 duration ≤ ${testCase.ceiling}s`, async () => {
    const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: `motion-cat-${testCase.selector.replace(/[^a-z0-9]/gi, "")}` });
    try {
      const page = await browser.newPage({ viewport: VIEWPORT });
      openPages.push(page);
      await openApp(page, server);
      if (testCase.arrive) await testCase.arrive(page);

      const durations = await page.locator(testCase.selector).first().evaluate((el) => {
        const s = getComputedStyle(el);
        return { animation: s.animationDuration, transition: s.transitionDuration };
      });
      for (const d of [...parseAllSeconds(durations.animation), ...parseAllSeconds(durations.transition)]) {
        expect(d, `${testCase.selector}`).toBeLessThanOrEqual(testCase.ceiling);
      }
    } finally {
      await cleanup();
    }
  });

  it(`reducedMotion 下，${testCase.selector} 的 animation/transition duration ≤ 0.001s`, async () => {
    const { server, cleanup } = await startServerForHelper({
      deckDir: demoDir,
      prefix: `motion-reduced-${testCase.selector.replace(/[^a-z0-9]/gi, "")}`,
    });
    try {
      const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
      const page = await context.newPage();
      openPages.push(page);
      await openApp(page, server);
      if (testCase.arrive) await testCase.arrive(page);
      // reducedMotion 下 duration 趨近 0 不代表 0——像 .floating-layer 這種入場動畫仍會
      // 從 opacity:0 起跑，只是幾乎瞬間跑完；緊接著 evaluate() 有機會量到還沒跑完那一格
      // 影格的 opacity（CI 上實測會量到 0，不是產品沒把內容顯示出來）。給一次事件迴圈
      // 加一個影格的時間讓它真的跑完，同檔其餘既有測試（如 F1）沒有這個問題是因為它們
      // 量的元素本身不是「淡入」動畫。
      await page.waitForTimeout(50);

      const el = page.locator(testCase.selector).first();
      const durations = await el.evaluate((node) => {
        const s = getComputedStyle(node);
        return { animation: s.animationDuration, transition: s.transitionDuration, opacity: s.opacity };
      });
      for (const d of [...parseAllSeconds(durations.animation), ...parseAllSeconds(durations.transition)]) {
        expect(d, `${testCase.selector}（reduced motion）`).toBeLessThanOrEqual(0.001);
      }
      expect(Number.parseFloat(durations.opacity), `${testCase.selector} 內容在 reduced motion 下仍可讀`).toBe(1);

      await context.close();
    } finally {
      await cleanup();
    }
  });
}

it("合法但奇怪：沒有任何動畫的元素（duration 為 0s）不算違規", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: "motion-no-animation" });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    openPages.push(page);
    await openApp(page, server);

    const duration = await page.locator(".status").evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseAllSeconds(duration).every((d) => d === 0)).toBe(true);
  } finally {
    await cleanup();
  }
});
