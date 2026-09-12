import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Locator, Page } from "playwright";
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

/**
 * Set to `1` to deliberately (re)write baselines instead of comparing
 * against them. Baselines are rendering-sensitive — a macOS-produced PNG
 * doesn't match ubuntu-latest's font rasterization closely enough to pass
 * CI's tolerance. Never set this locally to update a committed baseline;
 * instead run the `e2e` workflow via `workflow_dispatch` with
 * `update_baselines: true` (this is what sets the env var, on the same
 * runner CI compares against) and download the `appearance-baselines`
 * artifact it uploads.
 */
const UPDATE_ENV_VAR = "UPDATE_APPEARANCE_BASELINES";

/**
 * Set to `1` to skip the pixel comparison entirely and treat every call as
 * passing. Baselines are `ubuntu-latest`-rendered (CI's own runner); a local
 * machine's font rasterization (especially macOS) differs enough that a
 * pixel-level compare against those baselines fails deterministically, not
 * flakily. See AGENTS.md's "視覺回歸的把關分工" section for the local/CI
 * split this implements.
 */
const SKIP_ENV_VAR = "SKIP_APPEARANCE_BASELINES";

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
 * To deliberately change a baseline, run the `e2e` GitHub Actions workflow
 * via `workflow_dispatch` with `update_baselines: true` — the one supported
 * way, since it sets `UPDATE_APPEARANCE_BASELINES=1` on ubuntu-latest itself
 * rather than whatever OS ran it locally.
 */
export async function compareScreenshot(page: Page, options: CompareScreenshotOptions): Promise<void> {
  if (options.clip && options.fullPage) {
    throw new Error("compareScreenshot：`clip` 與 `fullPage` 不能同時指定 — 兩者代表不同的截圖範圍，互斥。");
  }

  const updateBaselines = process.env[UPDATE_ENV_VAR] === "1";

  if (!updateBaselines && process.env[SKIP_ENV_VAR] === "1") {
    console.log(`已跳過外觀截圖比對（CI 平台與基準平台不同）：${options.name}`);
    return;
  }

  const baselinePath = path.join(options.baselineDir, `${options.name}.png`);
  const actual = await page.screenshot({
    ...(options.clip ? { clip: options.clip } : { fullPage: options.fullPage ?? false }),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });

  if (updateBaselines) {
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
        `這是新基準嗎？到 GitHub Actions 手動觸發「e2e」workflow，勾選 update_baselines 來產生它，` +
        `下載 appearance-baselines artifact，檢查過截圖內容正確後再提交。`,
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
        `若這是刻意的外觀變更，到 GitHub Actions 手動觸發「e2e」workflow，勾選 update_baselines 來重新產生基準，` +
        `下載 appearance-baselines artifact，檢查過截圖內容正確後再提交。`,
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
      `若這是刻意的外觀變更，到 GitHub Actions 手動觸發「e2e」workflow，勾選 update_baselines 來重新產生基準，` +
      `下載 appearance-baselines artifact，檢查過截圖內容正確後再提交。`,
  );
}

/**
 * Waits until `page` — and, if present, its main slide `iframe.slide-frame`
 * — is render-stable before a screenshot is taken: fonts loaded in both
 * documents, the titlebar's own agent-connection badge past its transient
 * "Agent connected" placeholder (`TitleBar.tsx`'s `.agent-dot` — an
 * unrelated async SSE/fetch race that a broad sweep across this suite
 * confirmed exposed, not caused, by F8/NOOP-289: every affected baseline's
 * pixel differences are confined to this titlebar text/chat-panel chrome,
 * never the canvas/product content), then two animation frames so any
 * in-flight layout/paint from the most recent DOM change has settled. This
 * is on top of, not instead of, each call site's own `waitForTimeout(50)`
 * — that wait is about DOM writes landing; this one is about the render
 * pipeline (and this one async badge) catching up afterwards.
 *
 * The agent-dot wait is bounded and never throws: a caller with no agent
 * configured, or whose fixture never reaches "connected", still gets a
 * screenshot — just without this extra settle, exactly like before this
 * wait existed.
 */
export async function settleForScreenshot(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);

  const slideFrame = await findSlideFrame(page);
  if (slideFrame) {
    await slideFrame.evaluate(() => document.fonts.ready).catch(() => {});
  }

  await waitForAgentBadgeSettled(page);

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Bounded (1.5s), best-effort wait for `.agent-dot`'s text to stop reading
 * the generic "Agent connected" placeholder — see `settleForScreenshot`'s
 * own doc comment for why. Resolves (never rejects) whether or not the
 * element exists, ever changes, or the timeout is hit — this must never
 * be the reason a screenshot test hangs or fails.
 *
 * Every `Locator` call below carries an explicit short `timeout`: without
 * one, Playwright's own actionability wait (`textContent()` retries for up
 * to its 30s default) is what actually runs when `.agent-dot` does not
 * exist at all — play mode hides the whole titlebar, so this function's
 * very first call would otherwise block for 30 real seconds, long past
 * `PlayChrome.tsx`'s 2.5s control-bar auto-hide timer (`play-awake`'s own
 * screenshot went from "controls visible" to "already faded" this way —
 * a self-inflicted regression from this wait's first version, not a
 * pre-existing one; caught by re-running the whole suite after adding it).
 */
async function waitForAgentBadgeSettled(page: Page): Promise<void> {
  const deadline = Date.now() + 1500;
  const badge = page.locator(".agent-dot").first();
  while (Date.now() < deadline) {
    const text = await badge.textContent({ timeout: 200 }).catch(() => null);
    if (text === null || text.trim() !== "Agent connected") break;
    await page.waitForTimeout(50);
  }
  // Same startup race, a second incidental symptom of it: the status bar's
  // page nav (StatusBar.tsx, unconditionally rendered once mounted —
  // nothing about it depends on any single ticket) was also caught
  // mid-render in some of the same baselines. Bounded and non-throwing for
  // the same reason as the badge wait above.
  const deadline2 = Date.now() + 1500;
  const pageNav = page.locator(".status-page").first();
  while (Date.now() < deadline2) {
    if (await pageNav.isVisible().catch(() => false)) return;
    await page.waitForTimeout(50);
  }
}

/** Finds the main canvas iframe (`class="slide-frame"`), if the page has one. */
async function findSlideFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const element = await frame.frameElement().catch(() => null);
    if (element && (await element.getAttribute("class")) === "slide-frame") return frame;
  }
  return null;
}

export type Box = { x: number; y: number; width: number; height: number };

/** Upper bound on stability-check frames before `settledBox` gives up (NOOP-198's F1/F4 flake never needed more than a handful). */
const SETTLE_MAX_FRAMES = 20;

function boxesEqual(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Waits until every *finite* WAAPI animation running on `locator`'s element
 * (or its subtree) has reached its `finished` state. Animations with
 * `iterations: Infinity` (e.g. `chat.css`'s `chat-working-spin`) are
 * excluded — waiting on those would never resolve. A cancelled animation
 * rejects `.finished`; that's treated as "no longer running", not an error,
 * so a racing `resetToStep`-style cancel can't fail the caller.
 */
async function waitForFiniteAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (el) => {
    const animations = el.getAnimations({ subtree: true });
    const finite = animations.filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing ? timing.iterations !== Number.POSITIVE_INFINITY : true;
    });
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** Awaits one animation frame in the document that owns `locator`'s element — the iframe's own document for an element inside `iframe.slide-frame`, not the top-level page. */
async function waitOneAnimationFrame(locator: Locator): Promise<void> {
  await locator.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

/**
 * Returns `locator`'s `boundingBox()` only once it has stopped moving:
 * every finite entrance animation on it (or its subtree) has finished, and
 * two consecutive animation frames measured the exact same box afterwards.
 *
 * `boundingBox()` reports the box *after* CSS transforms are applied, so a
 * plain `boundingBox()` call taken while a `scale()`/`translateY()` entrance
 * animation (`.floating-layer`, `.table-cell-menu`, `.context-bar`) is still
 * running measures a box that is smaller/offset compared to the settled
 * state — this is what produced NOOP-198's ~42% F1/F4 screenshot-clip flake.
 * This function replaces "wait a fixed amount of time and hope it's enough"
 * with a measurement that only returns once it can prove, by direct
 * observation, that the box is no longer changing.
 */
export async function settledBox(locator: Locator, label: string): Promise<Box> {
  await waitForFiniteAnimations(locator);

  let previous = await locator.boundingBox();
  if (previous === null) throw new Error(`找不到 ${label} 的版面框`);

  let current: Box | null = null;
  for (let frame = 0; frame < SETTLE_MAX_FRAMES; frame++) {
    await waitOneAnimationFrame(locator);
    current = await locator.boundingBox();
    if (current === null) throw new Error(`找不到 ${label} 的版面框`);
    if (boxesEqual(previous, current)) return current;
    previous = current;
  }

  throw new Error(
    `${label} 的版面框在 ${SETTLE_MAX_FRAMES} 幀內未穩定下來（最後兩次量到：${JSON.stringify(previous)} → ${JSON.stringify(current)}）`,
  );
}
