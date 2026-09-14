// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

/**
 * Cross-cutting motion-budget verification: duration ceilings and
 * reduced-motion behaviour checked *across* the whole shell at once, rather
 * than per-feature.
 *
 * New v3 shell rebuild: the old ribbon/grid-view/template-dialog UI this
 * file used to exercise is gone (Ribbon.tsx, GridView.tsx, TemplateDialog.tsx
 * all deleted). Category ceilings below now map onto the New v3 shell's own
 * token set (tokens.css's `--dur-fast` 150ms / `--dur-base` 180ms — the old
 * three-tier `--dur-micro`/`--dur-panel`/`--dur-view` naming no longer
 * exists in tokens.css, which was rewritten wholesale onto the design
 * tokens doc's naming). The 300ms overall ceiling (below) and the two
 * category ceilings are still meaningful sanity checks even though the
 * specific named tokens they were once keyed to are gone: every New v3
 * shell animation/transition in fact uses `--dur-fast` or `--dur-base`,
 * both well under 300ms.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "docs/demo");

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

it("under normal motion, every (non-infinitely-looping) animation/transition duration site-wide is ≤ 0.300s (the --dur-view ceiling)", async () => {
  const { server, cleanup } = await startServerForHelper({ deckDir: demoDir, prefix: "motion-ceiling" });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    openPages.push(page);
    await openApp(page, server);

    const motions = await scanMotion(page);
    const offenders: string[] = [];
    for (const m of motions) {
      // The continuously-looping loading indicator (chat-working-spin,
      // chat.css) is not a one-shot "view switch/dialog" motion, so it is
      // exempt from this ceiling — it uses calc(var(--dur-base) * 4) as its
      // own cadence, a deliberate design choice, not a regression.
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
  { category: "micro-interaction (--dur-fast ≤160ms)", selector: ".dock-command", ceiling: 0.16 },
  // `.slide-nav-button` is not a good pick here: on the demo deck's first
  // slide the "previous" button is disabled (40% opacity, per shell.css's
  // global disabled rule), and the reduced-motion assertion requires
  // opacity to be 1 — using it would misreport as a violation.
  // `.dock-hand-button` has no disabled logic, is always visible/clickable,
  // and is a more stable sample of the same "micro-interaction" control class.
  { category: "micro-interaction (--dur-fast ≤160ms)", selector: ".dock-hand-button", ceiling: 0.16 },
  { category: "micro-interaction (--dur-fast ≤160ms)", selector: ".side-panel-tab", ceiling: 0.16 },
  {
    category: "panel (--dur-base ≤220ms)",
    selector: ".side-panel-tabpanel",
    ceiling: 0.22,
    arrive: async (page) => {
      await page.locator('.side-panel-tab[data-tab="style"]').click();
    },
  },
  {
    // New v3 shell's floating layers (the Dock's Insert panel / Shape /
    // Arrange / Zoom menus, all grown from the same spot per the design
    // doc) — grid-view/template-dialog have been deleted
    // (GridView.tsx/TemplateDialog.tsx removed entirely), and
    // `.floating-layer` is the one surviving floating-layer class that
    // plays an entrance animation (`floating-layer-in`, using --dur-fast).
    // Measured via the zoom menu's entrance (the one floating layer still
    // fully available).
    category: "floating layer (--dur-fast ≤300ms, replaces the deleted .grid-view/.template-dialog)",
    selector: ".floating-layer",
    ceiling: 0.3,
    arrive: async (page) => {
      await page.locator(".dock-zoom-control").click();
      await expect.poll(() => page.locator(".floating-layer").count()).toBe(1);
    },
  },
];

for (const testCase of CATEGORY_CASES) {
  it(`${testCase.category}: ${testCase.selector}'s duration ≤ ${testCase.ceiling}s`, async () => {
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

  it(`under reducedMotion, ${testCase.selector}'s animation/transition duration ≤ 0.001s`, async () => {
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
      // Under reducedMotion the duration approaches 0 but isn't exactly 0 —
      // an entrance animation like .floating-layer's still starts from
      // opacity:0, it just finishes almost instantly. A synchronous
      // evaluate() right after can catch a not-yet-finished frame's opacity
      // (observed as 0 on CI, not a real failure to render content). Give
      // it one event-loop tick plus a frame to actually finish; other
      // existing tests in this file are unaffected because the elements
      // they measure aren't fade-in animations.
      await page.waitForTimeout(50);

      const el = page.locator(testCase.selector).first();
      const durations = await el.evaluate((node) => {
        const s = getComputedStyle(node);
        return { animation: s.animationDuration, transition: s.transitionDuration, opacity: s.opacity };
      });
      for (const d of [...parseAllSeconds(durations.animation), ...parseAllSeconds(durations.transition)]) {
        expect(d, `${testCase.selector} (reduced motion)`).toBeLessThanOrEqual(0.001);
      }
      expect(Number.parseFloat(durations.opacity), `${testCase.selector} content stays readable under reduced motion`).toBe(1);

      await context.close();
    } finally {
      await cleanup();
    }
  });
}

it("legal but odd: an element with no animation at all (duration 0s) does not count as a violation", async () => {
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
