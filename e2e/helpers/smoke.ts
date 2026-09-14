// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Browser, Page } from "playwright";
import { expect } from "vitest";
import type { RunningServer } from "../../packages/server/src/serve.js";
import { openApp } from "./launch.js";
import { relativeLuminance, parseColor } from "./contrast.js";

/**
 * Cross-engine structural smoke check: Firefox and WebKit only ever run
 * this — no pixel baselines, since they are not required to match
 * Chromium pixel-for-pixel.
 *
 * Every selector below targets the current shell (an earlier
 * Ribbon/GridView/TemplateDialog shell was deleted). The "core flow"
 * section no longer exercises grid view or the template dialog (neither
 * exists any more); it now opens/closes the Dock's zoom menu instead —
 * structurally the same kind of check (a UI layer appears, then
 * disappears) against the Dock's floating layer.
 */
export async function runSmoke(browser: Browser, server: RunningServer, viewport: { width: number; height: number }): Promise<void> {
  const page = await openApp(browser, server, { viewport });
  try {
    // ── 1. Core flow ──────────────────────────────────────────────────
    await page.locator(".dock-zoom-control").click();
    await expect.poll(() => page.locator(".floating-layer").count()).toBe(1);
    await page.locator(".dock-zoom-control").click();
    await expect.poll(() => page.locator(".floating-layer").count()).toBe(0);

    await page.locator(".play-button").click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");
    // Unlike e2e/play-grid-visual.test.ts's switchToPlay (Chromium-only), this file also
    // runs on WebKit, where data-player-focus reaching "true" is not reliably observed
    // within 10s (confirmed by CI: the WebKit run times out here). data-mode flipping to
    // "play" is the actual view-switch signal this smoke check cares about; player-focus
    // timing is Chromium-specific behaviour already covered by play-grid-visual.test.ts.

    await page.locator(".play-bar .play-toggle-button.leave").click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("view");

    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await expect.poll(() => page.locator(".status-selection-chip").textContent()).toContain("Selected");

    // ── 2. Operability: every non-disabled control is ≥24×24 and fully on-screen ──
    for (const selector of [".slide-nav-button", ".side-panel-tab", ".dock-command", ".dock-hand-button", ".dock-zoom-control"]) {
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
        expect(box.width, `${selector} width`).toBeGreaterThanOrEqual(24);
        expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(24);
        expect(box.withinViewport, `${selector} stays within the viewport`).toBe(true);
      }
    }

    // ── 3. No overlap between the shell's major chrome regions ─────────
    // `.ribbon` has no equivalent any more (the Dock floats over the stage,
    // it doesn't occupy its own layout track); `.overview` was replaced by
    // the outer `.rail` (the thumbnail track is now just one segment of it).
    const regionSelectors = [".titlebar", ".rail", ".canvas-area", ".side-panel", ".status"];
    const regionBoxes: Array<{ selector: string; x: number; y: number; width: number; height: number }> = [];
    for (const selector of regionSelectors) {
      const box = await page.locator(selector).boundingBox();
      if (box) regionBoxes.push({ selector, ...box });
    }
    // 1px tolerance: adjacent regions are meant to abut with zero gap, but
    // Firefox's sub-pixel rounding for the same grid layout doesn't always
    // match Chromium exactly (same existing convention as
    // e2e/responsive-shell.test.ts's `scrollWidth <= clientWidth + 1`).
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
    // `measureOverflowAt` only *collects* violations; nothing throws until
    // every state has been visited and reported in one shot.
    const violations: string[] = [];
    await measureOverflowAt(page, "normal-selected", violations);

    await page.locator(".play-button").click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("play");
    // Play mode intentionally unmounts the editor chrome (App.tsx) — these
    // four regions are expected to be absent here, not a fallback for a
    // selector that failed to resolve.
    await measureOverflowAt(page, "play", violations, [".titlebar", ".rail", ".side-panel", ".status"]);
    await page.locator(".play-bar .play-toggle-button.leave").click();
    await expect.poll(() => page.locator(".app").getAttribute("data-mode")).toBe("view");

    await page.locator('.side-panel-tab[data-tab="style"]').click();
    await measureOverflowAt(page, "side-panel-style", violations);
    await page.locator('.side-panel-tab[data-tab="chat"]').click();

    await page.locator(".dock-zoom-control").click();
    await expect.poll(() => page.locator(".floating-layer").count()).toBe(1);
    await measureOverflowAt(page, "zoom-menu-open", violations);
    await page.locator(".dock-zoom-control").click();

    // ── 6. Not a light-mode break: .app's own painted background is dark ──
    // (not document.body — body itself carries no background rule; .app is
    // the themed root that paints --surface-1, see packages/web/src/styles/
    // shell.css.) Pushed onto the same `violations` array as §4/5 instead of
    // asserting here directly, so an overflow/clipping violation earlier in
    // the run doesn't short-circuit this check.
    //
    // The current shell's `.app` background is the warm-white `--surface-1`
    // (the shell chrome), not the dark stage well `--well-bg` — the design
    // ("stage first: light shell, dark stage") makes the *shell* light on
    // purpose, unlike the old all-dark shell this check used to guard. The
    // dark-surface guarantee that still holds is `.canvas-area` (the stage
    // well), so that is what this check now measures.
    const wellBackground = await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).backgroundColor);
    const wellLuminance = relativeLuminance(parseColor(wellBackground));
    if (wellLuminance >= 0.2) {
      violations.push(`stage background is not dark - relativeLuminance=${wellLuminance}`);
    }

    expect(violations, violations.join("\n")).toEqual([]);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Measures region clipping and page-level overflow at one screen state,
 * pushing a description of every violation onto `violations` instead of
 * asserting — the caller aggregates across every state it visits and
 * asserts once, so no single violation stops the rest of the states from
 * being measured (a previous per-region `expect` inside a loop made every
 * state after the first failure invisible to the test run).
 * `expectedAbsent` lists regions that are known not to exist for this
 * screen (e.g. play mode's chrome unmount) — anything absent that is *not*
 * on that list is itself a violation, not a silently skipped region.
 */
async function measureOverflowAt(page: Page, screen: string, violations: string[], expectedAbsent: string[] = []): Promise<void> {
  const regionSelectors = [".titlebar", ".rail", ".canvas-area", ".side-panel", ".status"];
  for (const selector of regionSelectors) {
    // `.locator(selector).boundingBox()` auto-waits the full default
    // timeout for a selector that resolves to zero elements instead of
    // returning null immediately — play mode legitimately has four of
    // these five selectors absent, so that call would hang ~30s per
    // selector instead of reporting "absent" right away. `.count()` never
    // waits; it is the existence check this loop actually wants.
    const count = await page.locator(selector).count();
    if (count === 0) {
      if (!expectedAbsent.includes(selector)) {
        violations.push(`${screen}: ${selector} expected present but missing`);
      }
      continue;
    }
    if (expectedAbsent.includes(selector)) {
      violations.push(`${screen}: ${selector} expected absent but present`);
      continue;
    }
    const overflow = await page.locator(selector).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    if (overflow.scrollWidth > overflow.clientWidth + 1) {
      violations.push(`${screen}: ${selector} has unexpected clipping - scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`);
    }
  }

  const pageOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (pageOverflow.scrollWidth > pageOverflow.innerWidth + 1) {
    violations.push(`${screen}: page has unexpected overflow - scrollWidth=${pageOverflow.scrollWidth} innerWidth=${pageOverflow.innerWidth}`);
  }
}
