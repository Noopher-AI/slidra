import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { CoMotionError } from "../comotion/errors.js";

export type ExportFormat = "pdf" | "pdf-frames";

export interface RenderExportPdfOptions {
  /** The origin (CLI's own `export/server.ts`, or an already-running `comotion serve`) that serves `export.html` and the three read-only routes it needs. */
  serverUrl: string;
  format: ExportFormat;
  /** Final destination — written atomically (temp file + rename), never left half-written on failure. */
  outputPath: string;
  /** Called once, as soon as the export page has derived its frame list. */
  onRunning: (totalFrames: number) => void;
  /** Called for every observed change in `completedFrames`, most-recent value only (no queued backlog of missed intermediate values — a progress bar only ever needs to show where things are *now*). */
  onProgress: (completedFrames: number, totalFrames: number) => void;
}

export interface RenderExportPdfResult {
  pageCount: number;
}

/**
 * How often to poll the page for progress while waiting. A small deck can
 * finish its entire render (navigate, fetch, N frames, all `ready`) in well
 * under a second — measured directly against `e2e/fixtures/export-deck`
 * (3 frames) during this ticket's own manual smoke test, where a 150ms
 * interval missed every single intermediate reading and only ever observed
 * the final state. 20ms is cheap (one `page.evaluate` round trip against a
 * page that is not otherwise busy) and catches at least one intermediate
 * value for decks this small; a real multi-slide deck's per-frame render
 * time dwarfs this either way.
 */
const POLL_INTERVAL_MS = 20;

/** Upper bound on the whole wait — matches export-entry.ts's own `READY_TIMEOUT_MS`, plus headroom for the browser launch/navigate that happens before that page-side timer even starts. */
const RENDER_TIMEOUT_MS = 130_000;

interface ExportProgress {
  total: number;
  completed: number;
}

declare global {
  interface Window {
    __COMOT_EXPORT__?: ExportProgress;
    __COMOT_EXPORT_DONE__?: boolean;
    __COMOT_EXPORT_ERROR__?: string;
  }
}

/**
 * Drives one headless Chromium page through `export.html` end to end
 * (NOOP-93 §3.4/§3.5/§4.5): navigate, poll `window.__COMOT_EXPORT__` for
 * progress, wait for done/error, then `page.pdf()` and write the bytes to
 * `outputPath`.
 *
 * `page.pdf()` needs `headless` Chromium — `chromium.launch()`'s default —
 * and must stay that way (plan §8's risk row): a non-headless launch would
 * throw, and this function deliberately never exposes a way to ask for one.
 */
export async function renderExportPdf(options: RenderExportPdfOptions): Promise<RenderExportPdfResult> {
  const { serverUrl, format, outputPath, onRunning, onProgress } = options;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Playwright's page.pdf() defaults to print media; this document ships
    // no print stylesheet, so screen media is what makes it render exactly
    // what an author would see on screen (§3.5's spike note — measured
    // identical either way today, but explicit so a future @media print
    // rule anywhere in the shared CSS cannot silently change this output).
    await page.emulateMedia({ media: "screen" });
    await page.goto(`${serverUrl}/export.html?format=${encodeURIComponent(format)}`);

    let reportedRunning = false;
    let lastCompleted = -1;
    const pollTimer = setInterval(() => {
      void page
        .evaluate(() => window.__COMOT_EXPORT__ ?? null)
        .then((progress) => {
          if (!progress) return;
          if (!reportedRunning) {
            reportedRunning = true;
            onRunning(progress.total);
          }
          if (progress.completed !== lastCompleted) {
            lastCompleted = progress.completed;
            onProgress(progress.completed, progress.total);
          }
        })
        .catch(() => {
          // The page may have navigated away or the browser may already be
          // closing — a transient poll failure here is not a render
          // failure; the waitForFunction below is what actually decides
          // success or failure.
        });
    }, POLL_INTERVAL_MS);

    let final: { canvas: { width: number; height: number }; progress: ExportProgress | null; error?: string };
    try {
      await page.waitForFunction(
        () => window.__COMOT_EXPORT_DONE__ === true || window.__COMOT_EXPORT_ERROR__ !== undefined,
        undefined,
        { timeout: RENDER_TIMEOUT_MS },
      );
      final = await page.evaluate(async () => {
        const response = await fetch("/api/presentation");
        const presentation = (await response.json()) as { canvas: { width: number; height: number } };
        return {
          canvas: presentation.canvas,
          progress: window.__COMOT_EXPORT__ ?? null,
          error: window.__COMOT_EXPORT_ERROR__,
        };
      });
    } finally {
      clearInterval(pollTimer);
    }

    if (final.error) {
      throw new CoMotionError(final.error);
    }
    if (!final.progress) {
      // Should be unreachable — export-entry.ts sets __COMOT_EXPORT__
      // before creating any iframe, so __COMOT_EXPORT_DONE__ can never
      // become true without it. Loud failure over a fabricated page count.
      throw new CoMotionError("匯出頁未回報進度，無法決定頁數");
    }

    const pdfBytes = await page.pdf({
      width: `${final.canvas.width}px`,
      height: `${final.canvas.height}px`,
      printBackground: true,
      // backdrop-filter is not applied by Chromium's PDF print path — real,
      // 2026-09-05 (Playwright 1.62.1 + bundled Chromium): page.pdf()
      // output for a fixture with and without a backdrop-filter element
      // rasterizes with zero perceptual difference (pixelmatch, default
      // threshold — raw PNG bytes can still differ slightly between the two
      // rasterizations, a canvas-rendering non-determinism unrelated to
      // backdrop-filter itself, so the pinned test compares perceptually,
      // not byte-for-byte; see its own comment), on both "screen" and
      // "print" emulated media. e2e/export-cli.test.ts pins this as a known
      // limitation (NOOP-93 §4.6); it is not a bug to "fix" here — see that
      // test's own comment before touching this again.
    });

    await writePdfAtomically(outputPath, pdfBytes);

    return { pageCount: final.progress.total };
  } finally {
    await browser.close();
  }
}

/** Temp file + rename, same discipline `workspace.ts`'s `writeRegistry` uses — a crash mid-write must never leave a truncated `.pdf` at `outputPath`. */
async function writePdfAtomically(outputPath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, outputPath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new CoMotionError("寫入匯出檔案時發生錯誤");
  }
}
