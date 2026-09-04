import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

/**
 * Cross-cutting motion-budget verification (NOOP-9 Plan §1/§4.7): duration
 * ceilings and reduced-motion behaviour checked *across* the whole shell at
 * once, rather than per-feature the way e2e/play-grid-visual.test.ts's F1-3,
 * e2e/side-panel-visual.test.ts's V9 and
 * e2e/workspace-side-panel-integration.test.ts's IP-5 already do (those are
 * not duplicated here — Plan §2.1-5).
 *
 * Category ceilings mirror tokens.css's own three tokens (packages/web/src/
 * styles/tokens.css:129-131) and, for the selector groups below, the actual
 * token each selector's CSS rule consumes today (verified by reading
 * source, not the category NOOP-9 Plan §4.7 guessed at — see this PR's
 * body: `.template-dialog`'s entrance animation consumes `var(--dur-view)`,
 * i.e. the "dialogs / view switches" token by tokens.css's own comment, not
 * `var(--dur-panel)` as the plan's table grouped it; using the plan's
 * grouping here would make this test fail against correct, unchanged
 * product CSS).
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
    await page.locator('.tab:has-text("常用")').click();

    const motions = await scanMotion(page);
    const offenders: string[] = [];
    for (const m of motions) {
      // 持續循環的載入指示器（chat-working-spin，chat.css/template-dialog.css）不是
      // 「view switch/dialog」類的一次性 motion，不受這個上限約束——它用
      // calc(var(--dur-view) * 3) 當自己的節奏，是刻意的設計決定，不是回歸。
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
  { category: "微互動（--dur-micro ≤160ms）", selector: ".cmd", ceiling: 0.16 },
  { category: "微互動（--dur-micro ≤160ms）", selector: ".view-btn", ceiling: 0.16 },
  { category: "微互動（--dur-micro ≤160ms）", selector: ".side-panel-tab", ceiling: 0.16 },
  {
    category: "面板類（--dur-panel ≤220ms）",
    selector: ".side-panel-tabpanel",
    ceiling: 0.22,
    arrive: async (page) => {
      await page.locator('.side-panel-tab[data-tab="style"]').click();
    },
  },
  {
    category: "檢視切換／對話框類（--dur-view ≤300ms，含 .template-dialog——見檔頭說明）",
    selector: ".grid-view",
    ceiling: 0.3,
    arrive: async (page) => {
      await page.locator('.view-btn[data-view="grid"]').click();
      await expect.poll(() => page.locator(".grid-view").count()).toBe(1);
    },
  },
  {
    category: "檢視切換／對話框類（--dur-view ≤300ms，含 .template-dialog——見檔頭說明）",
    selector: ".template-dialog",
    ceiling: 0.3,
    arrive: async (page) => {
      await page.locator('.tab:has-text("常用")').click();
      await page.locator('.cmd:has-text("範本")').click();
      await expect.poll(() => page.locator('[aria-label="範本管理"]').count()).toBe(1);
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
      await page.locator('.tab:has-text("常用")').click();
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
      await page.locator('.tab:has-text("常用")').click();
      if (testCase.arrive) await testCase.arrive(page);

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
