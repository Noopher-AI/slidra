import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/**
 * Perceptual-diff visual regression helper (ticket #49, tolerance added in
 * the E3.T8 non-determinism fix), following the existing precedent in
 * e2e/base-fragment-spike.test.ts: `page.screenshot()` + a pixel-level
 * comparison.
 *
 * This is a seam consumed by every later appearance ticket (#50 stage, #54
 * play — two baselines, #55 grid, #56 selection), so its shape supports
 * more than one baseline per test file (distinct `name`s under the same
 * `baselineDir`), a clipped-region shot (`clip` provided), a viewport-sized
 * shot (both omitted), and a true full-page shot (`fullPage: true`) for
 * views that can scroll beyond the viewport, such as #55's grid.
 *
 * Comparison tolerates a small number of anti-aliasing-level pixel
 * differences (see `MAX_DIFF_PIXELS_RATIO`) but stays exact on image
 * dimensions — callers are responsible for launching Playwright's own
 * bundled Chromium (`playwright`'s `chromium.launch()`, never a
 * system/channel browser) and for setting a fixed viewport size; nothing
 * here does either, because both are call-site decisions this helper
 * cannot make safely on a caller's behalf.
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

/** `pixelmatch`'s own default sensitivity for per-pixel colour delta. */
const PIXELMATCH_THRESHOLD = 0.1;

/** Fraction of total pixels allowed to differ before a mismatch is a failure. */
const MAX_DIFF_PIXELS_RATIO = 0.0002;

/** Absolute floor for `MAX_DIFF_PIXELS_RATIO`, so small clips (e.g. `status-bar`) don't collapse back to byte-exact. */
const MIN_DIFF_PIXELS = 50;

/** Failed-comparison diagnostics land here — gitignored, not a baseline. */
function failedDir(baselineDir: string): string {
  return path.join(path.dirname(baselineDir), "__failed__");
}

/**
 * Screenshots `page` (or the given `clip` of it) and compares the result
 * against the committed baseline `<baselineDir>/<name>.png`, tolerating a
 * small number of anti-aliasing-level pixel differences.
 *
 * The default path is comparison, and it fails loudly, never silently:
 * - A missing baseline is an explicit error, never a silent write-and-pass
 *   — that would make the test pass forever regardless of what changed.
 * - A dimension mismatch is always a failure, with no tolerance applied —
 *   it means the viewport, clip, or layout changed, which is a real
 *   regression rather than rendering noise.
 * - A pixel-count mismatch beyond the tolerance is an explicit error naming
 *   the baseline path, the diff pixel count/ratio, and where the `actual`
 *   and `diff` PNGs were written for inspection.
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
  const actual = await page.screenshot({
    ...(options.clip ? { clip: options.clip } : { fullPage: options.fullPage ?? false }),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });

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

  // Fast path: identical bytes never need decoding or a pixel diff.
  if (actual.equals(expected)) return;

  const actualPng = PNG.sync.read(actual);
  const expectedPng = PNG.sync.read(expected);

  if (actualPng.width !== expectedPng.width || actualPng.height !== expectedPng.height) {
    throw new Error(
      `外觀截圖尺寸與基準不符：${baselinePath}` +
        `（實際 ${actualPng.width}x${actualPng.height}，基準 ${expectedPng.width}x${expectedPng.height}）\n` +
        `若這是刻意的外觀變更，執行「${UPDATE_ENV_VAR}=1」重新跑這個測試檔來重新產生基準，檢查過截圖內容正確後再提交。`,
    );
  }

  const { width, height } = actualPng;
  const diffPng = new PNG({ width, height });
  const diffPixels = pixelmatch(actualPng.data, expectedPng.data, diffPng.data, width, height, {
    threshold: PIXELMATCH_THRESHOLD,
  });

  const totalPixels = width * height;
  const maxDiffPixels = Math.max(MIN_DIFF_PIXELS, Math.floor(totalPixels * MAX_DIFF_PIXELS_RATIO));

  if (diffPixels <= maxDiffPixels) return;

  const failedDirPath = failedDir(options.baselineDir);
  await mkdir(failedDirPath, { recursive: true });
  const actualPath = path.join(failedDirPath, `${options.name}.actual.png`);
  const diffPath = path.join(failedDirPath, `${options.name}.diff.png`);
  await writeFile(actualPath, actual);
  await writeFile(diffPath, PNG.sync.write(diffPng));

  const ratio = ((diffPixels / totalPixels) * 100).toFixed(3);
  throw new Error(
    `外觀截圖與基準不符：${baselinePath}\n` +
      `差異像素數：${diffPixels} / ${totalPixels}（${ratio}%），容忍上限：${maxDiffPixels}\n` +
      `實際截圖：${actualPath}\n差異圖：${diffPath}\n` +
      `若這是刻意的外觀變更，執行「${UPDATE_ENV_VAR}=1」重新跑這個測試檔來重新產生基準，檢查過截圖內容正確後再提交。`,
  );
}

/**
 * Waits until `page` — and, if present, its main slide `iframe.slide-frame`
 * — is render-stable before a screenshot is taken: fonts loaded in both
 * documents, then two animation frames so any in-flight layout/paint from
 * the most recent DOM change has settled. This is on top of, not instead
 * of, each call site's own `waitForTimeout(50)` — that wait is about DOM
 * writes landing; this one is about the render pipeline catching up
 * afterwards.
 */
export async function settleForScreenshot(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);

  const slideFrame = await findSlideFrame(page);
  if (slideFrame) {
    await slideFrame.evaluate(() => document.fonts.ready).catch(() => {});
  }

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Finds the main canvas iframe (`class="slide-frame"`), if the page has one. */
async function findSlideFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  return null;
}
