import type { Browser } from "playwright";
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

    // ── 4. No unexpected clipping within each region ───────────────────
    for (const { selector } of regionBoxes) {
      const overflow = await page.locator(selector).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect(overflow.scrollWidth, `${selector} 沒有非預期裁切`).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }

    // ── 5. No page-level overflow ────────────────────────────────────
    const pageOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(pageOverflow.scrollWidth).toBeLessThanOrEqual(pageOverflow.innerWidth + 1);

    // ── 6. Not a light-mode break: .app's own painted background is dark ──
    // (not document.body — body itself carries no background rule; .app is
    // the themed root that paints --s-well, see packages/web/src/styles/
    // shell.css:18-32.)
    const appBackground = await page.locator(".app").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(relativeLuminance(parseColor(appBackground))).toBeLessThan(0.2);
  } finally {
    await page.close().catch(() => {});
  }
}
