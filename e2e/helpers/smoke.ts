import type { Browser, Page } from "playwright";
import { expect } from "vitest";
import type { RunningServer } from "../../packages/server/src/serve.js";
import { openApp } from "./launch.js";
import { relativeLuminance, parseColor } from "./contrast.js";

/**
 * Cross-engine structural smoke check (NOOP-9 Plan §1/§4.5): Firefox and
 * WebKit only ever run this — no pixel baselines, "not required to match
 * Chromium pixel-for-pixel" per the parent ticket's own AC. Every wait
 * condition and selector below is copied from e2e/play-grid-visual.test.ts
 * / e2e/side-panel-visual.test.ts / e2e/responsive-shell.test.ts, all of
 * which already run on Chromium in CI — nothing here is a new interaction
 * pattern, only a re-execution on two more engines.
 */
export async function runSmoke(browser: Browser, server: RunningServer, viewport: { width: number; height: number }): Promise<void> {
  const page = await openApp(browser, server, { viewport });
  try {
    // ── 1. Core flow ──────────────────────────────────────────────────
    await page.locator('.view-btn[data-view="grid"]').click();
    await expect.poll(() => page.locator(".grid-view").count()).toBe(1);

    await page.locator('.view-btn[data-view="normal"]').click();
    await expect.poll(() => page.locator(".grid-view").count()).toBe(0);

    await page.locator('.view-btn[data-view="play"]').click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");
    // Unlike e2e/play-grid-visual.test.ts's switchToPlay (Chromium-only), this file also
    // runs on WebKit, where data-player-focus reaching "true" is not reliably observed
    // within 10s (NOOP-9 Plan §4.5's own flagged assumption, confirmed by CI: WebKit run
    // times out here). data-mode flipping to "play" is the actual view-switch signal this
    // smoke check cares about; player-focus timing is Chromium-specific behaviour already
    // covered by play-grid-visual.test.ts's B1.

    await page.locator(".play-bar .play-toggle-button.leave").click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("view");

    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => page.locator(".status .sel-name").textContent()).toContain("已選取");

    // ── 2. Operability: every non-disabled control is ≥24×24 and fully on-screen ──
    await page.locator('.tab:has-text("常用")').click();
    for (const selector of [".view-btn", ".slide-nav-button", ".side-panel-tab", ".cmd"]) {
      const boxes = await page
        .locator(`${selector}:not([disabled])`)
        .evaluateAll((els, vp) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              width: r.width,
              height: r.height,
              withinViewport: r.x >= 0 && r.y >= 0 && r.x + r.width <= vp.width && r.y + r.height <= vp.height,
            };
          }),
          viewport,
        );
      for (const box of boxes) {
        expect(box.width, `${selector} 寬度`).toBeGreaterThanOrEqual(24);
        expect(box.height, `${selector} 高度`).toBeGreaterThanOrEqual(24);
        expect(box.withinViewport, `${selector} 落在 viewport 內`).toBe(true);
      }
    }

    // ── 3. No overlap between the shell's major chrome regions ─────────
    const regionSelectors = [".titlebar", ".ribbon", ".overview", ".canvas-area", ".side-panel", ".status"];
    const regionBoxes: Array<{ selector: string; x: number; y: number; width: number; height: number }> = [];
    for (const selector of regionSelectors) {
      const box = await page.locator(selector).boundingBox();
      if (box) regionBoxes.push({ selector, ...box });
    }
    // 1px 容忍：相鄰區塊理論上零 gap 貼合，Firefox 對同一個 grid 版面的次像素
    // 捨入跟 Chromium 不完全一致，CI 上實測 .overview × .canvas-area 邊界曾算出
    // <1px 的假重疊——這是引擎間的次像素渲染差，不是版面真的重疊（同一個既有
    // 慣例見 e2e/responsive-shell.test.ts 的 `scrollWidth <= clientWidth + 1`）。
    const OVERLAP_TOLERANCE = 1;
    for (let i = 0; i < regionBoxes.length; i++) {
      for (let j = i + 1; j < regionBoxes.length; j++) {
        const a = regionBoxes[i];
        const b = regionBoxes[j];
        const overlaps =
          a.x < b.x + b.width - OVERLAP_TOLERANCE &&
          a.x + a.width - OVERLAP_TOLERANCE > b.x &&
          a.y < b.y + b.height - OVERLAP_TOLERANCE &&
          a.y + a.height - OVERLAP_TOLERANCE > b.y;
        expect(overlaps, `${a.selector} × ${b.selector}`).toBe(false);
      }
    }

    // ── 4/5. No unexpected clipping, at every screen state ──────────────
    // NOOP-51: the original version of this check ran `expect` per-region
    // inside the loop, so the first violation threw and aborted the test —
    // every region/state after the first offender was never exercised, on
    // both the region and the page-overflow check. Two rounds in a row each
    // fixed exactly the one selector the aborted run happened to reach and
    // shipped with the rest still unmeasured. `measureOverflowAt` below
    // only *collects* violations; nothing throws until every state has been
    // visited and reported in one shot (violations aggregated, see below).
    const violations: string[] = [];
    await measureOverflowAt(page, "normal-selected", violations);

    await page.locator('.view-btn[data-view="grid"]').click();
    await expect.poll(() => page.locator(".grid-view").count()).toBe(1);
    await measureOverflowAt(page, "grid", violations);
    await page.locator('.view-btn[data-view="normal"]').click();
    await expect.poll(() => page.locator(".grid-view").count()).toBe(0);

    await page.locator('.view-btn[data-view="play"]').click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");
    // Play mode intentionally unmounts the editor chrome (App.tsx) — these
    // five regions are expected to be absent here, not a fallback for a
    // selector that failed to resolve.
    await measureOverflowAt(page, "play", violations, [".titlebar", ".ribbon", ".overview", ".side-panel", ".status"]);
    await page.locator(".play-bar .play-toggle-button.leave").click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("view");

    await page.locator('.side-panel-tab[data-tab="style"]').click();
    await measureOverflowAt(page, "side-panel-style", violations);
    await page.locator('.side-panel-tab[data-tab="chat"]').click();

    await page.locator('.tab:has-text("常用")').click();
    await page.locator('.cmd:has-text("範本")').click();
    await expect.poll(() => page.locator('[aria-label="範本管理"]').count()).toBe(1);
    await measureOverflowAt(page, "template-dialog", violations);

    // ── 6. Not a light-mode break: .app's own painted background is dark ──
    // (not document.body — body itself carries no background rule; .app is
    // the themed root that paints --s-well, see packages/web/src/styles/
    // shell.css:18-32.) Pushed onto the same `violations` array as §4/5
    // instead of asserting here directly, so an overflow/clipping violation
    // earlier in the run doesn't short-circuit this check (NOOP-52).
    const appBackground = await page.locator(".app").evaluate((el) => getComputedStyle(el).backgroundColor);
    const appLuminance = relativeLuminance(parseColor(appBackground));
    if (appLuminance >= 0.2) {
      violations.push(`背景不是深色 - relativeLuminance=${appLuminance}`);
    }

    expect(violations, violations.join("\n")).toEqual([]);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Measures region clipping (§4) and page-level overflow (§5) at one screen
 * state, pushing a description of every violation onto `violations` instead
 * of asserting — the caller aggregates across every state it visits and
 * asserts once, so no single violation stops the rest of the states from
 * being measured (NOOP-51: the previous per-region `expect` inside a loop
 * made every state after the first failure invisible to the test run).
 * `expectedAbsent` lists regions that are known not to exist for this
 * screen (e.g. play mode's chrome unmount) — anything absent that is *not*
 * on that list is itself a violation, not a silently skipped region.
 */
async function measureOverflowAt(page: Page, screen: string, violations: string[], expectedAbsent: string[] = []): Promise<void> {
  const regionSelectors = [".titlebar", ".ribbon", ".overview", ".canvas-area", ".side-panel", ".status"];
  for (const selector of regionSelectors) {
    // `.locator(selector).boundingBox()` auto-waits the full default
    // timeout for a selector that resolves to zero elements instead of
    // returning null immediately — play mode legitimately has five of
    // these six selectors absent, so that call would hang ~30s per
    // selector instead of reporting "absent" right away. `.count()` never
    // waits; it is the existence check this loop actually wants.
    const count = await page.locator(selector).count();
    if (count === 0) {
      if (!expectedAbsent.includes(selector)) {
        violations.push(`${screen}：${selector} 預期存在但缺席`);
      }
      continue;
    }
    if (expectedAbsent.includes(selector)) {
      violations.push(`${screen}：${selector} 預期缺席但實際存在`);
      continue;
    }
    const overflow = await page.locator(selector).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    if (overflow.scrollWidth > overflow.clientWidth + 1) {
      violations.push(`${screen}：${selector} 沒有非預期裁切 - scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`);
    }
  }

  const pageOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (pageOverflow.scrollWidth > pageOverflow.innerWidth + 1) {
    violations.push(`${screen}：頁面沒有非預期 overflow - scrollWidth=${pageOverflow.scrollWidth} innerWidth=${pageOverflow.innerWidth}`);
  }
}
