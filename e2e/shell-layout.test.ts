// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";

/**
 * Verifies that shell layout dimensions at 1280x720 and 2560x1440 match the
 * design prototype. Neither the prototype nor the written spec
 * (01-DESIGN_TOKENS.md's spacing/sizing section, 02-DESIGN_DOC.md §3) is
 * ever actually run or measured, so this file checks the literal values
 * that land in tokens.css directly — those values are already mechanically
 * checked against 01-DESIGN_TOKENS.md by packages/web/test/tokens.test.ts, and
 * what this file verifies is whether the CSS values actually take effect as
 * the corresponding layout sizes in the browser. The two are complementary,
 * not redundant.
 *
 * Tolerance is ±1px (sub-pixel rounding, since boundingBox() returns floats).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "docs/demo");

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
];

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

async function boundingBoxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no measured boundingBox (missing or not rendered)`);
  return box;
}

for (const viewport of VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`;

  it(`${label}: shell region sizes match the values landed in tokens.css`, async () => {
    const started: StartedServer = await startServerFor({ deckDir: demoDir, prefix: `shell-layout-${label}` });
    try {
      const page = await openApp(browser, started.server, { viewport });
      openPages.push(page);

      const titlebar = await boundingBoxOf(page, ".titlebar");
      expect(titlebar.height).toBeCloseTo(48, 0);

      const rail = await boundingBoxOf(page, ".rail");
      expect(rail.width).toBeCloseTo(212, 0);

      const sidePanel = await boundingBoxOf(page, ".side-panel");
      expect(sidePanel.width).toBeCloseTo(340, 0);

      const notes = await boundingBoxOf(page, ".notes");
      expect(notes.height).toBeCloseTo(112, 0);

      const statusBar = await boundingBoxOf(page, ".status");
      expect(statusBar.height).toBeGreaterThanOrEqual(36 - 1);

      const dock = await boundingBoxOf(page, ".dock");
      expect(dock.height).toBeCloseTo(46, 0);

      // Stage whitespace: read .canvas-area's computed padding directly
      // (28px top / 36px left-right / 76px bottom, reserved for the dock)
      // rather than deriving it from the difference between .canvas-area's
      // and .stage's boundingBox — .stage fits the available space with
      // aspect-ratio + max-width/height, and when that available space
      // isn't exactly 16:9 (the rail/side-panel/notes layout in this shell
      // doesn't guarantee a stage area that comes out to exactly 16:9),
      // extra letterboxing appears on one axis. That letterboxing isn't the
      // padding value itself and isn't what this test verifies — stage
      // centering and that extra whitespace's behavior are already covered
      // by the DOCK_RESERVATION assertions in e2e/stage.test.ts. This file
      // only checks whether the literal padding values in tokens.css
      // actually take effect.
      const padding = await page.locator(".canvas-area").evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          top: parseFloat(cs.paddingTop),
          right: parseFloat(cs.paddingRight),
          bottom: parseFloat(cs.paddingBottom),
          left: parseFloat(cs.paddingLeft),
        };
      });
      expect(padding.top).toBeCloseTo(28, 0);
      expect(padding.right).toBeCloseTo(36, 0);
      expect(padding.left).toBeCloseTo(36, 0);
      expect(padding.bottom).toBeCloseTo(76, 0);
    } finally {
      await started.cleanup();
    }
  });
}
