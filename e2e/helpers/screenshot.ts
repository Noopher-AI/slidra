import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

/**
 * Byte-exact visual regression helper (ticket #49), following the existing
 * precedent in e2e/base-fragment-spike.test.ts: `page.screenshot()` +
 * `Buffer.equals`, no perceptual-diff threshold, no fuzzy matching.
 *
 * This is a seam consumed by every later appearance ticket (#50 stage, #54
 * play — two baselines, #55 grid, #56 selection), so its shape supports
 * more than one baseline per test file (distinct `name`s under the same
 * `baselineDir`), a clipped-region shot (`clip` provided), a viewport-sized
 * shot (both omitted), and a true full-page shot (`fullPage: true`) for
 * views that can scroll beyond the viewport, such as #55's grid.
 *
 * Comparison is byte-exact and stays that way regardless of engine —
 * callers are responsible for launching Playwright's own bundled Chromium
 * (`playwright`'s `chromium.launch()`, never a system/channel browser) and
 * for setting a fixed viewport size; nothing here does either, because
 * both are call-site decisions this helper cannot make safely on a
 * caller's behalf.
 */
export interface CompareScreenshotOptions {
  /** Distinct name for this baseline within `baselineDir` — becomes `<name>.png`. */
  name: string;
  /** Directory the named baseline PNGs for this test file live under. */
  baselineDir: string;
  /** Clip region in CSS pixels; omit for a viewport-sized (or, with `fullPage`, page-sized) screenshot. Mutually exclusive with `fullPage`. */
  clip?: { x: number; y: number; width: number; height: number };
  /**
   * Capture the full scrollable page rather than just the viewport.
   * Defaults to `false` (viewport-sized shot). Mutually exclusive with
   * `clip` — passing both is a caller error, not a silent preference.
   */
  fullPage?: boolean;
}

/** Set (e.g. `UPDATE_APPEARANCE_BASELINES=1 npx vitest run …`) to deliberately (re)write baselines instead of comparing against them. */
const UPDATE_ENV_VAR = "UPDATE_APPEARANCE_BASELINES";

/**
 * Screenshots `page` (or the given `clip` of it) and compares the result
 * byte-for-byte against the committed baseline `<baselineDir>/<name>.png`.
 *
 * The default path is comparison, and it fails loudly, never silently:
 * - A missing baseline is an explicit error, never a silent write-and-pass
 *   — that would make the test pass forever regardless of what changed.
 * - A byte mismatch is an explicit error naming the baseline path and both
 *   buffers' sizes.
 *
 * Set `UPDATE_APPEARANCE_BASELINES=1` to deliberately (re)write the
 * baseline instead of comparing — the one supported way to change a
 * baseline on purpose.
 */
export async function compareScreenshot(page: Page, options: CompareScreenshotOptions): Promise<void> {
  if (options.clip && options.fullPage) {
    throw new Error("compareScreenshot：`clip` 與 `fullPage` 不能同時指定 — 兩者代表不同的截圖範圍，互斥。");
  }

  const baselinePath = path.join(options.baselineDir, `${options.name}.png`);
  const actual = await page.screenshot(options.clip ? { clip: options.clip } : { fullPage: options.fullPage ?? false });

  if (process.env[UPDATE_ENV_VAR] === "1") {
    await mkdir(options.baselineDir, { recursive: true });
    await writeFile(baselinePath, actual);
    return;
  }

  let expected: Buffer;
  try {
    expected = await readFile(baselinePath);
  } catch {
    throw new Error(
      `找不到基準截圖：${baselinePath}\n` +
        `這是新基準嗎？執行「${UPDATE_ENV_VAR}=1」重新跑這個測試檔來產生它，檢查過截圖內容正確後再提交。`,
    );
  }

  if (!actual.equals(expected)) {
    throw new Error(
      `外觀截圖與基準不符：${baselinePath}（實際 ${actual.length} bytes，基準 ${expected.length} bytes）\n` +
        `若這是刻意的外觀變更，執行「${UPDATE_ENV_VAR}=1」重新跑這個測試檔來重新產生基準，檢查過截圖內容正確後再提交。`,
    );
  }
}
