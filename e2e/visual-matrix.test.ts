import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp as openAppHelper, requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";
import { matrixScenarios } from "./helpers/matrix-scenarios.js";

/**
 * The data-driven core-interface visual regression matrix (NOOP-9 Plan §1/
 * §4.4): 10 scenarios × 3 desktop viewports = 30 full-viewport Chromium
 * baselines under e2e/__screenshots__/matrix. This is in addition to, not a
 * replacement for, the existing single-1440×900-baseline appearance suites
 * (appearance.test.ts, stage.test.ts, shell.test.ts, …) — those keep their
 * own baselines untouched (Plan §2.1-4).
 *
 * Baselines can only be produced on CI (ubuntu-latest + Playwright's bundled
 * Chromium) via `.github/workflows/e2e.yml`'s `update_baselines` dispatch —
 * see AGENTS.md「視覺回歸的把關分工」. Locally this file still runs (with
 * `SKIP_APPEARANCE_BASELINES=1`) to prove every scenario reaches its target
 * state, but the pixel comparison itself is not evidence outside CI.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const brokenEffectsDeckDir = path.join(e2eDir, "fixtures/broken-effects-deck");
const baselineDir = path.join(e2eDir, "__screenshots__", "matrix");

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
];

const SCENARIOS = matrixScenarios({ demoDir, brokenEffectsDeckDir });

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

for (const scenario of SCENARIOS) {
  it(`矩陣：${scenario.id} 場景在 1280×720／1440×900／2560×1440 都有穩定基準`, async () => {
    // One server per scenario, shared across its three viewports (Plan §4.4
    // 決定 9：10 台伺服器，不是 30 台) — each viewport gets its own page/
    // arrive() run so scenario state (selection, route interception, view
    // mode) never bleeds from one viewport into the next.
    const { server, registry, presentationId, cleanup } = await startServerForHelper({
      deckDir: scenario.deckDir,
      prefix: `visual-matrix-${scenario.id}`,
    });
    try {
      for (const viewport of VIEWPORTS) {
        const page = await openAppHelper(browser, server, { viewport });
        openPages.push(page);

        try {
          await scenario.arrive(page, { registry, presentationId });
        } catch (error) {
          throw new Error(`場景 "${scenario.id}" @ ${viewport.width}x${viewport.height} 未能到達目標狀態：${(error as Error).message}`);
        }

        await settleForScreenshot(page);
        await page.waitForTimeout(50);
        await compareScreenshot(page, {
          name: `${scenario.id}-${viewport.width}x${viewport.height}`,
          baselineDir,
        });
      }
    } finally {
      await cleanup();
    }
  });
}

it("涵蓋狀態：六種代表性互動狀態各至少有一個場景涵蓋", () => {
  const ids = new Set(SCENARIOS.map((s) => s.id));
  const coverage: Record<string, string[]> = {
    hover: ["standard-hover"],
    focus: ["standard-focus"],
    selected: ["standard-selected"],
    disabled: ["standard"],
    loading: ["grid-loading"],
    error: ["play-error"],
  };
  for (const [state, candidateIds] of Object.entries(coverage)) {
    expect(candidateIds.some((id) => ids.has(id)), `狀態 "${state}" 沒有對應場景`).toBe(true);
  }
});

