import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";
import { loadPdf } from "./helpers/pdf.js";
import type { ExportSseEvent } from "../apps/web/src/live-reload.js";

interface ExportRecording {
  sse: ExportSseEvent[];
  dom: string[];
}

/** Every item of `sub` appears, in order, somewhere in `full` (extra items in `full` are fine). DOM updates can only lag the event sequence (React batches renders), never show a value no event ever carried. */
function isSubsequenceOf(sub: readonly string[], full: readonly string[]): boolean {
  let i = 0;
  for (const item of full) if (i < sub.length && sub[i] === item) i++;
  return i === sub.length;
}

/**
 * The GUI export panel.
 *
 * `export-deck` (3 slides, 6 per-step frames) is used to verify "progress
 * appears after picking a format, a download is available on completion, and
 * the CLI and GUI produce the same output"; the "still in progress" scenario
 * instead uses a larger deck built here on the fly (see buildManyFrameDeck),
 * purely to give Playwright a wide enough time window to actually catch a
 * "still running" frame — the 6-frame export-deck has, on this machine,
 * finished entirely before the polling command was even issued. The larger
 * frame count only exists to widen that time window; the progress assertions
 * themselves don't depend on the frame count (the number and distinctness of
 * progress events is a function of machine speed, not a product contract).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBinPath = path.join(rootDir, "target/release/slidra");

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

/** A deck with many slides, each with a couple of steps, purely to widen the render window for the "still in progress" screenshot below. */
async function buildManyFrameDeck(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slidra-export-gui-deck-"));
  await mkdir(path.join(dir, "slides"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  const slideCount = 15;
  const slides: string[] = [];
  for (let i = 1; i <= slideCount; i++) {
    const name = `slides/${String(i).padStart(3, "0")}.svg`;
    slides.push(name);
    await writeFile(
      path.join(dir, name),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
  <metadata>
    <slidra:effects xmlns:slidra="https://slidra.app/ns/2026">
      <slidra:effect target="el-step-a-${i}" family="enter" effect="fade" start="on-click"/>
      <slidra:effect target="el-step-b-${i}" family="enter" effect="appear" start="on-click"/>
    </slidra:effects>
  </metadata>
  <text id="el-title-${i}" x="640" y="120" text-anchor="middle" font-size="48">投影片 ${i}</text>
  <text id="el-step-a-${i}" x="640" y="320" text-anchor="middle" font-size="40">步驟一</text>
  <text id="el-step-b-${i}" x="640" y="440" text-anchor="middle" font-size="40">步驟二</text>
</svg>
`,
    );
  }
  await writeFile(
    path.join(dir, "project.json"),
    JSON.stringify({
      formatVersion: 1,
      name: "多格畫面測試簡報",
      canvas: { width: 1280, height: 720 },
      slides,
    }),
  );
  return dir;
}

interface CliResult {
  code: number | null;
  stdout: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(slidraBinPath, args, { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: error ? (error.code as number) : 0, stdout });
    });
  });
}

describe("export panel — progress, download, and parity with the CLI output", () => {
  it("clicking pdf-frames shows progress, produces a working download link on completion, and matches the CLI export", async () => {
    // 45 frames (15 slides x 3 frames) instead of the 6-frame export-deck:
    // as explained at the top of the file and in buildManyFrameDeck, the
    // 6-frame deck often finishes exporting entirely before the polling
    // commands are even issued, so progress never visibly moves. This frame
    // count exists only to widen the time window for the 409 test and the
    // "export in progress" scenario; the progress assertions below don't
    // depend on it.
    const manyFrameDeckDir = await buildManyFrameDeck();
    try {
      const started: StartedServer = await startServerFor({ deckDir: manyFrameDeckDir, prefix: "export-gui-parity" });
      try {
        const page = await openApp(browser, started.server);
        openPages.push(page);

        // Earlier attempts kept getting stuck on "polling to sample a
        // window a few hundred milliseconds wide" — the 45-frame export
        // takes only ~1s from click to download link, with the actual
        // frame-rendering time even shorter, so the sampling rate can't
        // keep up with the event rate and the same assertion goes flaky
        // roughly half the time even against correct code. Instead, install
        // two lossless recorders inside the page: each event is pushed into
        // an in-page array as it happens, and the test only reads it back
        // once at the end, so no amount of test-side stalling (GC, CDP
        // round-trips) can ever miss an event or a DOM update.
        await page.evaluate(async () => {
          const w = window as unknown as { __exportRec?: ExportRecording; __exportRecEs?: EventSource };
          const rec: ExportRecording = { sse: [], dom: [] };
          w.__exportRec = rec;
          // The MutationObserver must attach to the always-present
          // .export-panel-anchor: .export-status only exists once busy/done/
          // error, so attaching to it directly would mean there's nothing to
          // observe before the export even starts (ExportPanel.tsx's three
          // conditional blocks).
          const anchor = document.querySelector(".export-panel-anchor");
          if (!anchor) throw new Error("找不到 .export-panel-anchor");
          const record = () => {
            const text = (document.querySelector(".export-status")?.textContent ?? "").trim();
            if (text && text !== rec.dom[rec.dom.length - 1]) rec.dom.push(text);
          };
          new MutationObserver(record).observe(anchor, { subtree: true, childList: true, characterData: true });
          record();
          // Open a second /api/events stream ourselves: changes.ts's
          // broadcast fans out to every open stream, so this one receives
          // the exact same event sequence as App.tsx's, without needing to
          // hook into the already-loaded app.
          const es = new EventSource("/api/events");
          w.__exportRecEs = es;
          es.addEventListener("export", (ev) => rec.sse.push(JSON.parse((ev as MessageEvent).data)));
          // Must wait for "open" before returning: POST /api/export's
          // "queued" broadcast is synchronous, so a not-yet-established
          // connection would miss the first event.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("EventSource 未在 5s 內連上")), 5_000);
            es.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        });

        await page.getByRole("button", { name: "Export" }).click();
        await page.getByRole("menu").waitFor({ timeout: 5_000 });
        await page.locator(".export-menu-item", { hasText: "One page per animation step" }).click();

        await page.locator(".export-status-done a").waitFor({ timeout: 30_000 });
        const rec: ExportRecording = await page.evaluate(() => {
          const w = window as unknown as { __exportRec: ExportRecording; __exportRecEs: EventSource };
          w.__exportRecEs.close(); // Close in the same evaluate() that reads it back, so a failed assertion never leaves the connection open
          return w.__exportRec;
        });

        // (1) The product actually emits progress events. This is a
        //     mutation guard: removing job.ts's progress broadcast would
        //     make this 0. It's structurally guaranteed not to be 0 on
        //     correct code — render.ts's lastCompleted is seeded at -1, so
        //     the first successfully observed poll of the export page is
        //     guaranteed to call onProgress, even if completed is still 0.
        //     This holds regardless of deck size, machine speed, or whether
        //     polling keeps up.
        const progressEvents = rec.sse.filter((e) => e.state === "progress");
        expect(progressEvents, `未收到任何 state:"progress" 的 export SSE 事件。完整序列：${JSON.stringify(rec.sse)}`)
          .not.toHaveLength(0);

        // (2) The event sequence is valid and belongs to a single job (after
        //     collapsing consecutive duplicates, the states are exactly these four).
        expect(rec.sse.map((e) => e.state).filter((s, i, a) => s !== a[i - 1]))
          .toEqual(["queued", "running", "progress", "done"]);
        expect(new Set(rec.sse.map((e) => e.jobId)).size).toBe(1);

        // (3) progress events' completedFrames is monotonically non-decreasing
        //     and never exceeds totalFrames. Don't assert
        //     done.completedFrames === totalFrames: render.ts's
        //     waitForFunction can resolve before clearInterval fires on the
        //     last poll — a done event with completedFrames 33/45 has been
        //     observed in practice.
        const completed = progressEvents.map((e) => e.completedFrames);
        expect(completed).toEqual([...completed].sort((a, b) => a - b));
        expect(progressEvents.every((e) => e.completedFrames <= e.totalFrames)).toBe(true);

        // (4) Every text the DOM ever displayed is a value some event
        //     actually carried, and in the same order. Using "subsequence"
        //     rather than equality: React coalesces events that arrive in
        //     the same tick — running(0/45) and progress(7/45) have been
        //     observed arriving in the same millisecond, with the DOM
        //     rendering only the latter. Equality would be a new source of
        //     flakiness.
        const expectedTexts = rec.sse.flatMap((e) => {
          if (e.state === "queued") return ["匯出中…"]; // this is also App.tsx's optimistic state
          if (e.state === "running" || e.state === "progress")
            return [e.totalFrames > 0 ? `匯出中… ${e.completedFrames}/${e.totalFrames}` : "匯出中…"];
          if (e.state === "done") return [`下載 ${e.fileName}（${e.pageCount} 頁）`];
          return [];
        });
        expect(isSubsequenceOf(rec.dom, expectedTexts)).toBe(true);

        // (5) The DOM ends up showing the download link, with text matching the done event.
        const doneEvent = rec.sse.find((e) => e.state === "done");
        expect(doneEvent).toBeDefined();
        expect(rec.dom.at(-1)).toBe(`下載 ${doneEvent!.fileName}（${doneEvent!.pageCount} 頁）`);

        const downloadLink = page.locator(".export-status-done a");
        const downloadPath = await downloadLink.getAttribute("href");
        expect(downloadPath).toMatch(/^\/api\/export\/[a-f0-9]+\/file$/);

        const response = await page.request.get(`${started.server.url}${downloadPath}`);
        expect(response.ok()).toBe(true);
        expect(response.headers()["content-type"]).toBe("application/pdf");
        const guiPdfBytes = await response.body();

        // Compare against the PDF the CLI produces for the same
        // presentation: same page count, same per-page viewport size, same
        // rasterized pixels per page — not byte equality (Chromium writes
        // /CreationDate, so the raw bytes will always differ).
        const cliOutPath = path.join(tmpdir(), `cli-${started.presentationId}.pdf`);
        const cliResult = await runCli(
          ["export", started.presentationId, "--format", "pdf-frames", "--out", cliOutPath],
          process.env,
        );
        expect(cliResult.code).toBe(0);
        const cliPdfBytes = await readFile(cliOutPath);

        const guiInfo = await loadPdf(browser, guiPdfBytes);
        const cliInfo = await loadPdf(browser, cliPdfBytes);
        try {
          expect(guiInfo.numPages).toBe(cliInfo.numPages);
          expect(guiInfo.pageSizes).toEqual(cliInfo.pageSizes);
          for (let i = 0; i < guiInfo.numPages; i++) {
            const guiRaster = await guiInfo.rasterizePage(i);
            const cliRaster = await cliInfo.rasterizePage(i);
            expect(guiRaster.equals(cliRaster)).toBe(true);
          }
        } finally {
          await guiInfo.close();
          await cliInfo.close();
          await rm(cliOutPath, { force: true });
        }
      } finally {
        await started.cleanup();
      }
    } finally {
      await rm(manyFrameDeckDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it("shows the same error block on a 409 response", async () => {
    // Uses the 45-frame deck rather than the 6-frame export-deck: the first
    // request must still be running when the second is sent, and the 6-frame
    // deck often finishes exporting entirely between the two Playwright
    // actions, so the 409 would never occur (see the file header comment and
    // buildManyFrameDeck for why).
    //
    // The second request deliberately hits the API directly rather than
    // going through a UI click: once the first job starts, this tab's own
    // SSE subscription also receives running/progress, which correctly
    // makes ExportPanel disable both format rows (an in-progress job disables
    // both format rows) — that's correct behavior, meaning "click an
    // already-disabled button" isn't a path any real user could reach, so
    // using it to trigger the 409 would just be testing a scenario that
    // can't happen.
    const manyFrameDeckDir = await buildManyFrameDeck();
    try {
      const started: StartedServer = await startServerFor({
        deckDir: manyFrameDeckDir,
        prefix: "export-gui-409",
      });
      try {
        const page = await openApp(browser, started.server);
        openPages.push(page);

        const first = await page.request.post(`${started.server.url}/api/export`, {
          data: { format: "pdf-frames" },
        });
        expect(first.ok()).toBe(true);

        const second = await page.request.post(`${started.server.url}/api/export`, {
          data: { format: "pdf" },
        });
        expect(second.status()).toBe(409);
        const body = (await second.json()) as { error: string };
        expect(body.error).toBe("已有匯出工作進行中");
      } finally {
        await started.cleanup();
      }
    } finally {
      await rm(manyFrameDeckDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it("shows the same error block and re-enables format rows when export fails mid-run (broken effect list)", async () => {
    const brokenEffectsDeckDir = path.join(rootDir, "e2e/fixtures/broken-effects-deck");
    const started: StartedServer = await startServerFor({
      deckDir: brokenEffectsDeckDir,
      prefix: "export-gui-error",
    });
    try {
      const page = await openApp(browser, started.server);
      openPages.push(page);

      await page.getByRole("button", { name: "Export" }).click();
      await page.getByRole("menu").waitFor({ timeout: 5_000 });
      await page.locator(".export-menu-item", { hasText: "One page per slide" }).click();

      await page.locator(".export-status-error").waitFor({ timeout: 30_000 });
      const errorText = await page.locator(".export-status-error").textContent();
      // slides/001.svg's breakage: a media effect missing data-slidra-media
      // (the raw text thrown by player-plan.ts's mediaCuesFor, matching the
      // same assertion in export-cli.test.ts).
      expect(errorText).toContain("el-speaker");
      expect(errorText).toContain("data-slidra-media");

      // On error, the format rows must become clickable again.
      await page.getByRole("button", { name: "Export" }).click();
      await expect
        .poll(async () => page.locator(".export-menu-item").first().isEnabled(), { timeout: 5_000 })
        .toBe(true);

      // The real fixture's error is one short line —
      // not long enough to reproduce the off-viewport bug the way a real
      // 9-line backend message does. Swap the already-rendered node's own
      // text directly (React never re-renders over this — it owns the
      // text, not this test) for a synthetic ~300-char message with
      // embedded newlines, then measure geometry. Pre-fix (`nowrap` +
      // `right:0` shrink-to-fit) this pushes the box's left edge and most
      // of its content off the left side of the viewport; post-fix it
      // wraps and stays fully on-screen.
      const geometry = await page.locator(".export-status-error").evaluate((el) => {
        const longMessage = "壞掉的效果清單：" + "元素｢el-speaker｣缺少 data-slidra-media 屬性，這是一段刻意加長、含有換行的合成錯誤訊息，用來驗證錯誤區塊在極端長度下仍完整落在畫面內。\n第二行：".repeat(4);
        const textNode = Array.from(el.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
        if (textNode) textNode.textContent = longMessage;
        else el.textContent = longMessage;
        const rect = el.getBoundingClientRect();
        // el.getClientRects() on `.export-status-error` itself (a flex,
        // block-level box) is always exactly 1 rect regardless of how the
        // text inside wraps — a block box's fragments don't multiply with
        // its content's line count. To actually observe "did this wrap
        // onto more than one line", the rects have to come from a Range
        // over the text node, which — like an inline run — gets one
        // ClientRect per line box (verified against a standalone flex/
        // pre-wrap repro before writing this: element bocard was always 1,
        // Range over its text node was 6 for the same wrapped content).
        const range = document.createRange();
        if (textNode) range.selectNodeContents(textNode);
        const lineCount = textNode ? range.getClientRects().length : 0;
        return { left: rect.left, right: rect.right, lineCount };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      const viewportWidth = page.viewportSize()?.width;
      if (viewportWidth === undefined || viewportWidth === null) throw new Error("找不到 viewport 寬度");
      expect(geometry.right).toBeLessThanOrEqual(viewportWidth);
      expect(geometry.lineCount).toBeGreaterThan(1);
    } finally {
      await started.cleanup();
    }
  }, 60_000);
});
