/**
 * 匯出頁 (NOOP-93 §1/§3.4/§3.5). Loaded directly by `export/render.ts`'s
 * headless Chromium (both the CLI path and — via the same shared
 * `export/server.ts` — the GUI's `POST /api/export` path use this exact
 * page, so both produce the same PDF).
 *
 * Reads `/api/presentation` and each slide's markup from the same
 * read-only routes `serve.ts` shares with the export server
 * (`read-routes.ts`), derives the frame list from `computePlayerPlan` per
 * §4.5's page-count formula, and stacks one sandboxed iframe per frame
 * using `wrapPlayDocument` — the exact function the live player itself
 * uses (§7 decision 1/2/3: no new rendering path, no runtime changes).
 *
 * Progress is exposed on `window.__COMOT_EXPORT__` for `render.ts`'s
 * Playwright driver to poll; completion/failure on
 * `window.__COMOT_EXPORT_DONE__` / `window.__COMOT_EXPORT_ERROR__`.
 */
import { computePlayerPlan, renderHideStyle, renderPlanScript, type PlayerPlan } from "./player-plan.js";
import { slideDirectory, wrapPlayDocument } from "./canvas.js";

export type ExportFormat = "pdf" | "pdf-frames";

export interface ExportProgress {
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

/** How long to wait for every stacked frame to report `ready` before giving up (plan §8's risk row — a huge deck should not hang forever). */
const READY_TIMEOUT_MS = 120_000;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`載入失敗：${path}`);
  return (await response.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`載入失敗：${path}`);
  return response.text();
}

interface FrameSpec {
  slidePath: string;
  startStep: number;
  svgMarkup: string;
  plan: PlayerPlan;
}

/**
 * §4.5's page-count formula, one formula for both formats (no `if` on step
 * count): `pdf` takes exactly the final state (`steps.length - 1`, which is
 * `-1` — the untouched opening state — for a slide with no effects at all);
 * `pdf-frames` takes every state from `-1` through `steps.length - 1`
 * inclusive, i.e. `steps.length + 1` frames.
 */
function stepsFor(format: ExportFormat, stepCount: number): number[] {
  if (format === "pdf") return [stepCount - 1];
  const steps: number[] = [];
  for (let step = -1; step < stepCount; step++) steps.push(step);
  return steps;
}

/**
 * Injects the page size and per-frame layout once the canvas size is known
 * (only available after `/api/presentation` resolves, so this cannot be
 * static markup in export.html). Generated document, not product UI — same
 * exception category `canvas.ts`'s own `wrapPlayDocument` already uses for
 * literal pixel values (design-contract.test.ts only forbids literals in
 * *product* UI source, not in strings assembled from runtime-known data).
 */
function applyPageLayout(width: number, height: number): void {
  const style = document.createElement("style");
  style.textContent =
    `@page { size: ${width}px ${height}px; margin: 0 }` +
    `html, body { margin: 0; padding: 0; }` +
    `.export-frame { display: block; width: ${width}px; height: ${height}px; border: 0; break-after: page; }`;
  document.head.appendChild(style);
}

/** Resolves once `total` frames have posted `{ source: "comot-player", event: "ready" }`, or rejects after `READY_TIMEOUT_MS`. */
function waitForAllReady(getCompleted: () => number, total: number): Promise<void> {
  if (total === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("簡報過大，請改用 CLI 分批"));
    }, READY_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (getCompleted() >= total) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const format = params.get("format");
  if (format !== "pdf" && format !== "pdf-frames") {
    throw new Error(`format 必須是 pdf 或 pdf-frames，收到：${format}`);
  }

  const presentation = await fetchJson<{ slides: string[]; canvas: { width: number; height: number } }>(
    "/api/presentation",
  );
  if (presentation.slides.length === 0) {
    throw new Error("簡報沒有投影片");
  }
  applyPageLayout(presentation.canvas.width, presentation.canvas.height);
  // §4.6: the export wait condition must include `document.fonts.ready`.
  // Each stacked iframe is an opaque origin (sandbox="allow-scripts", no
  // allow-same-origin — ADR-0010), so this document cannot reach into any
  // of them to await their own font loading directly. Awaiting it here,
  // on the outer document, before any iframe exists, warms the browser's
  // font cache for the shared `/api/raw/fonts/...` URL every iframe's own
  // injected `@font-face` (wrapPlayDocument's PRESENTATION_FONT_FACE_STYLE,
  // untouched) will request — by the time the first iframe's own fetch for
  // that URL happens, it resolves from cache instead of racing that
  // iframe's own "ready" postMessage.
  await document.fonts.ready;

  // Every slide's markup and plan is read/derived before any iframe is
  // created — a malformed effect list (the `/api/effects/` fetch rejecting)
  // fails the whole export here, before a single frame exists, matching
  // the CLI's "不產生半份 PDF" contract (§4.3's table).
  const frames: FrameSpec[] = [];
  for (const slidePath of presentation.slides) {
    const svgMarkup = await fetchText(`/api/files/${slidePath}`);
    const plan = await computePlayerPlan(svgMarkup, slidePath);
    for (const startStep of stepsFor(format, plan.steps.length)) {
      frames.push({ slidePath, startStep, svgMarkup, plan });
    }
  }

  let readyCount = 0;
  window.__COMOT_EXPORT__ = { total: frames.length, completed: 0 };
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { source?: string; event?: string } | null;
    if (data?.source === "comot-player" && data.event === "ready") {
      readyCount++;
      window.__COMOT_EXPORT__ = { total: frames.length, completed: readyCount };
    }
  });

  for (const frame of frames) {
    const hideStyle = renderHideStyle(frame.plan.hidden);
    const planScript = renderPlanScript(frame.plan, frame.startStep);
    const doc = wrapPlayDocument(
      frame.svgMarkup,
      `/api/raw/${slideDirectory(frame.slidePath)}`,
      hideStyle,
      planScript,
    );
    const iframe = document.createElement("iframe");
    iframe.className = "export-frame";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.srcdoc = doc;
    document.body.appendChild(iframe);
  }

  await waitForAllReady(() => readyCount, frames.length);
  window.__COMOT_EXPORT_DONE__ = true;
}

main().catch((error: unknown) => {
  window.__COMOT_EXPORT_ERROR__ = error instanceof Error ? error.message : String(error);
});
