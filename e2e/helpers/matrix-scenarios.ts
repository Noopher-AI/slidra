import type { Page } from "playwright";
import { expect } from "vitest";
import type { CommandRegistry } from "@co-motion/cli";

/**
 * The data-driven core-interface scenario table shared by
 * `e2e/visual-matrix.test.ts` (Chromium × 3 viewports, pixel baselines) and
 * `e2e/a11y.test.ts` (Chromium × 1440×900, axe scan) — NOOP-9 Plan §1/§4.4.
 * Each scenario names the deck it needs and how to drive an already-opened
 * `page` (post `openApp`) into its target state; navigation steps below are
 * the same selectors and wait conditions already proven in
 * e2e/play-grid-visual.test.ts, e2e/side-panel-visual.test.ts,
 * e2e/template-dialog.test.ts and e2e/responsive-shell.test.ts — none of
 * this is a new interaction pattern.
 */

export interface MatrixScenarioContext {
  registry: CommandRegistry;
  presentationId: string;
}

export interface MatrixScenario {
  id: string;
  /** Absolute path to the deck this scenario's server should be started against. */
  deckDir: string;
  /** Drives an already-opened, already-settled `page` into this scenario's target state. */
  arrive: (page: Page, ctx: MatrixScenarioContext) => Promise<void>;
}

export interface MatrixScenarioDeps {
  demoDir: string;
  brokenEffectsDeckDir: string;
}

/** Same wait as e2e/play-grid-visual.test.ts's switchToPlay: entering play mode hands focus to the player asynchronously once its runtime posts "ready", so a wait on data-player-focus is required, not just data-mode. */
async function switchToPlay(page: Page): Promise<void> {
  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
}

async function switchToGrid(page: Page): Promise<void> {
  await page.locator('.view-btn[data-view="grid"]').click();
  await expect.poll(() => page.locator(".grid-view").count()).toBe(1);
}

export function matrixScenarios(deps: MatrixScenarioDeps): MatrixScenario[] {
  const scenarios: MatrixScenario[] = [
    {
      id: "standard",
      deckDir: deps.demoDir,
      arrive: async () => {
        // Already at the standard view once openApp resolves — nothing further to do.
      },
    },
    {
      id: "standard-selected",
      deckDir: deps.demoDir,
      arrive: async (page) => {
        await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
        await expect.poll(() => page.locator(".status .sel-name").textContent()).toContain("已選取");
      },
    },
    {
      id: "standard-hover",
      deckDir: deps.demoDir,
      arrive: async (page) => {
        await page.locator('.view-btn[data-view="grid"]').hover();
      },
    },
    {
      id: "standard-focus",
      deckDir: deps.demoDir,
      arrive: async (page) => {
        // Chromium's :focus-visible input-modality flag is page-global, not per-element
        // (proven in e2e/side-panel-visual.test.ts's V4 case) — a Tab keypress anywhere
        // flips it to "keyboard", after which .focus() on any element shows the outline.
        await page.keyboard.press("Tab");
        await page.locator('.slide-nav-button[aria-label="下一頁"]').focus();
      },
    },
    {
      id: "grid",
      deckDir: deps.demoDir,
      arrive: async (page) => {
        await switchToGrid(page);
        await expect.poll(() => page.locator("iframe.grid-frame").count()).toBeGreaterThan(0);
      },
    },
    {
      id: "grid-loading",
      deckDir: deps.demoDir,
      arrive: async (page) => {
        // Holds every thumbnail fetch open forever so the grid stays in its loading state
        // for the screenshot — installed only now, after openApp's own initial-slide fetch
        // has already completed, so it cannot hang the page open above.
        await page.route("**/api/files/**", () => {
          // Never resolves — no route.fulfill()/continue()/abort() call.
        });
        await switchToGrid(page);
        await expect.poll(() => page.locator("figure.grid-cell").count()).toBeGreaterThan(0);
      },
    },
    {
      id: "play",
      deckDir: deps.demoDir,
      arrive: async (page) => {
        await switchToPlay(page);
      },
    },
    {
      id: "play-error",
      deckDir: deps.brokenEffectsDeckDir,
      arrive: async (page) => {
        await page.locator('.view-btn[data-view="play"]').click();
        const errorNotice = page.locator(".player-error-notice", { hasText: "效果清單" });
        await expect.poll(() => errorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);
      },
    },
    {
      id: "side-panel-style",
      deckDir: deps.demoDir,
      arrive: async (page) => {
        await page.locator('.side-panel-tab[data-tab="style"]').click();
        await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
        await expect.poll(() => page.locator('.style-field[data-attr="fill"] input').count()).toBe(1);
      },
    },
    {
      id: "template-dialog",
      deckDir: deps.demoDir,
      arrive: async (page, ctx) => {
        const added = await ctx.registry.dispatch<{ templatePath: string }>("template add", {
          id: ctx.presentationId,
          from: "slides/001.svg",
          name: "矩陣基準用範本",
        });
        if (!added.ok) throw new Error(`template add 失敗：${added.message}`);

        await page.locator('.tab:has-text("常用")').click();
        await page.locator('.cmd:has-text("範本")').click();
        await expect.poll(() => page.locator('[aria-label="範本管理"]').count()).toBe(1);
      },
    },
  ];

  // Same reasoning as e2e/visual-qa/run.ts's flattenScenarios(): a duplicate id would
  // silently overwrite one scenario's baseline with another's — fail at load time,
  // before any browser is even launched, not partway through the matrix.
  const seenIds = new Set<string>();
  for (const scenario of scenarios) {
    if (seenIds.has(scenario.id)) throw new Error(`matrixScenarios：場景 id 重複："${scenario.id}"`);
    seenIds.add(scenario.id);
  }

  return scenarios;
}
