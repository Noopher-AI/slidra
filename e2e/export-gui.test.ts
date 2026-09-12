import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";
import { compareScreenshot, settleForScreenshot } from "./helpers/screenshot.js";
import { loadPdf } from "./helpers/pdf.js";
import type { ExportSseEvent } from "../packages/web/src/live-reload.js";

interface ExportRecording {
  sse: ExportSseEvent[];
  dom: string[];
}

/** `sub` 的每一項都依序出現在 `full` 裡（允許 full 有多的）。DOM 只會少於事件序列（React 批次合併），永遠不會多出事件沒帶過的值。 */
function isSubsequenceOf(sub: readonly string[], full: readonly string[]): boolean {
  let i = 0;
  for (const item of full) if (i < sub.length && sub[i] === item) i++;
  return i === sub.length;
}

/**
 * GUI Export 面板 (#210 條件 3/4，NOOP-93 §4.7)。
 *
 * `export-deck`（3 張投影片、6 個逐幀畫格）拿來驗證「按下格式後有進度、
 * 完成後可下載、CLI 與 GUI 產出同一份」；截圖比對的「進度中」情境改用一份
 * 這裡動態產生、有更多畫格的簡報（見 buildManyFrameDeck），單純是為了給
 * Playwright 足夠的時間視窗真的抓到「還在進行中」的畫面——用 6 格的
 * export-deck 曾經在本機整個匯出於截圖指令發出前就已經跑完。45 格只是給
 * 這個時間視窗與截圖測試用；進度斷言本身不依賴格數（NOOP-104 §3.2：進度
 * 事件的數量與相異值個數是機器速度的函數，不是產品契約）。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const exportDeckDir = path.join(rootDir, "e2e/fixtures/export-deck");
const baselineDir = path.join(e2eDir, "__screenshots__/export");
const coMotionBinPath = path.join(rootDir, "target/release/comotion");

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
  const dir = await mkdtemp(path.join(tmpdir(), "comotion-export-gui-deck-"));
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
    <comot:effects xmlns:comot="https://co-motion.dev/ns">
      <comot:effect target="el-step-a-${i}" family="enter" effect="fade" start="on-click"/>
      <comot:effect target="el-step-b-${i}" family="enter" effect="appear" start="on-click"/>
    </comot:effects>
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
    execFile(coMotionBinPath, args, { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: error ? (error.code as number) : 0, stdout });
    });
  });
}

describe("Export 面板 — 進度、下載、與 CLI 產出一致（#210 條件 3/4）", () => {
  it("點 pdf-frames：出現進度、完成後下載連結可用、內容與 CLI 匯出的一致", async () => {
    // 45 格（15 張投影片 × 3 格）而不是 6 格的 export-deck：檔頭註解與
    // buildManyFrameDeck 自己的理由——6 格常常在截圖/輪詢指令發出前就已經
    // 整個匯出完，看不出進度真的有在動。這個格數是給 409 測試與「匯出進行
    // 中」截圖測試撐時間視窗用的，下面的進度斷言不依賴它。
    const manyFrameDeckDir = await buildManyFrameDeck();
    try {
      const started: StartedServer = await startServerFor({ deckDir: manyFrameDeckDir, prefix: "export-gui-parity" });
      try {
        const page = await openApp(browser, started.server);
        openPages.push(page);

        // 第 1、2 輪都卡在「用輪詢去取樣一個幾百毫秒的視窗」——45 格的匯出
        // 從點擊到出現下載連結只有 ~1s，其中真正在跑格子的時間更短，取樣頻率
        // 追不上事件速度，於是同一個斷言在正確的程式碼上也會約一半機率變紅
        // （NOOP-103）。這裡改成在頁面內裝兩個「無損記錄器」：事件一發生就被
        // 寫進頁面內的陣列，測試端只在最後一次性讀回，所以測試端自己再怎麼
        // 停頓（GC、CDP 往返）都不可能漏掉任何一次事件或任何一次 DOM 更新。
        await page.evaluate(async () => {
          const w = window as unknown as { __exportRec?: ExportRecording; __exportRecEs?: EventSource };
          const rec: ExportRecording = { sse: [], dom: [] };
          w.__exportRec = rec;
          // MutationObserver 必須掛在永遠存在的 .export-panel-anchor 上：
          // .export-status 只在 busy/done/error 才存在，掛在它上面等於還沒開始
          // 就沒有觀察對象（ExportPanel.tsx 的三個條件式區塊）。
          const anchor = document.querySelector(".export-panel-anchor");
          if (!anchor) throw new Error("找不到 .export-panel-anchor");
          const record = () => {
            const text = (document.querySelector(".export-status")?.textContent ?? "").trim();
            if (text && text !== rec.dom[rec.dom.length - 1]) rec.dom.push(text);
          };
          new MutationObserver(record).observe(anchor, { subtree: true, childList: true, characterData: true });
          record();
          // 自己再開一條 /api/events：changes.ts 的 broadcast 是對所有開著的
          // stream fan-out，所以這條會收到與 App.tsx 那條一模一樣的事件序列，
          // 而且不必去 hook 已經載入完成的應用程式。
          const es = new EventSource("/api/events");
          w.__exportRecEs = es;
          es.addEventListener("export", (ev) => rec.sse.push(JSON.parse((ev as MessageEvent).data)));
          // 必須等到 open 才回來：POST /api/export 的 queued 是同步廣播的，
          // 連線還沒建立就會漏掉第一則。
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
          w.__exportRecEs.close(); // 讀回的同一次 evaluate 裡就關掉，斷言失敗也不會留下連線
          return w.__exportRec;
        });

        // (1) 產品真的發出了 progress 事件。這是本輪的突變守衛：拿掉 job.ts
        //     的 progress broadcast，這裡就是 0。結構性保證它在正確程式碼上
        //     不會是 0——render.ts 的 lastCompleted 種子是 -1，所以第一次成功
        //     觀察到匯出頁的輪詢一定會呼叫 onProgress，即使 completed 還是 0。
        //     這與 deck 大小、機器速度、輪詢是否跟得上都無關。
        const progressEvents = rec.sse.filter((e) => e.state === "progress");
        expect(progressEvents, `未收到任何 state:"progress" 的 export SSE 事件。完整序列：${JSON.stringify(rec.sse)}`)
          .not.toHaveLength(0);

        // (2) 事件序列合法且屬於同一個 job（去掉連續重複後，狀態恰好是這四個）。
        expect(rec.sse.map((e) => e.state).filter((s, i, a) => s !== a[i - 1]))
          .toEqual(["queued", "running", "progress", "done"]);
        expect(new Set(rec.sse.map((e) => e.jobId)).size).toBe(1);

        // (3) progress 的 completedFrames 單調不減、不超過 totalFrames。
        //     不要斷言 done.completedFrames === totalFrames：render.ts 的
        //     waitForFunction 可能先解出、clearInterval 早於最後一次輪詢，
        //     實測看過 done 帶 33/45（見計畫 NOOP-104 §3.3 ROUND 2）。
        const completed = progressEvents.map((e) => e.completedFrames);
        expect(completed).toEqual([...completed].sort((a, b) => a - b));
        expect(progressEvents.every((e) => e.completedFrames <= e.totalFrames)).toBe(true);

        // (4) 畫面顯示過的每一則文字，都是某個事件真的帶過的值，順序也一致。
        //     用「子序列」而不是相等：React 會合併同一個 tick 內到達的事件，
        //     實測看過 running(0/45) 與 progress(7/45) 同毫秒到達、畫面只渲染
        //     出後者（NOOP-104 §3.3 ROUND 1）。相等會是新的 flaky。
        const expectedTexts = rec.sse.flatMap((e) => {
          if (e.state === "queued") return ["匯出中…"]; // App.tsx 樂觀狀態也是這一則
          if (e.state === "running" || e.state === "progress")
            return [e.totalFrames > 0 ? `匯出中… ${e.completedFrames}/${e.totalFrames}` : "匯出中…"];
          if (e.state === "done") return [`下載 ${e.fileName}（${e.pageCount} 頁）`];
          return [];
        });
        expect(isSubsequenceOf(rec.dom, expectedTexts)).toBe(true);

        // (5) 畫面最後停在下載連結，文字與 done 事件一致。
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

        // 與 CLI 對同一份簡報跑出來的 PDF 比對：頁數相同、每頁 viewport 尺寸
        // 相同、每頁光柵化後像素相同——不比對 bytes（Chromium 會寫入
        // /CreationDate，位元組不會相同，見 §5 第 5 條）。
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

  it("收到 409 時顯示同一個錯誤區塊", async () => {
    // 用 45 格的簡報而不是 6 格的 export-deck：第一個請求必須在第二個送出
    // 時仍在跑，6 格在本機常常整個匯出在兩次 Playwright 動作之間就跑完，
    // 409 永遠不會發生（見檔頭註解、buildManyFrameDeck 自己的理由）。
    //
    // 第二個請求刻意直接打 API，不透過 UI 點擊：一旦第一個 job 開始，這個
    // 分頁自己的 SSE 訂閱也會收到 running/progress，讓 ExportPanel 正確地
    // 把兩個格式列都停用（§4.7：「job 在 running/progress → 兩個格式列
    // 停用」）——這是對的行為，代表「點一個已停用的按鈕」不是任何使用者
    // 真的能走到的路徑，用它來製造 409 反而是在測一個假情境。
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

  it("匯出中途失敗（效果清單壞掉）時，畫面出現同一個錯誤區塊，格式列恢復可點", async () => {
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
      // slides/001.svg 的損壞之處：media 效果缺少 data-comot-media
      // （player-plan.ts 的 mediaCuesFor 丟出的原文，見 export-cli.test.ts
      // 同一個斷言）。
      expect(errorText).toContain("el-speaker");
      expect(errorText).toContain("data-comot-media");

      // §4.7：「error → ... 格式列恢復可點」。
      await page.getByRole("button", { name: "Export" }).click();
      await expect
        .poll(async () => page.locator(".export-menu-item").first().isEnabled(), { timeout: 5_000 })
        .toBe(true);

      // F-18 (NOOP-355 #287): the real fixture's error is one short line —
      // not long enough to reproduce the off-viewport bug the way a real
      // 9-line backend message does. Swap the already-rendered node's own
      // text directly (React never re-renders over this — it owns the
      // text, not this test) for a synthetic ~300-char message with
      // embedded newlines, then measure geometry. Pre-fix (`nowrap` +
      // `right:0` shrink-to-fit) this pushes the box's left edge and most
      // of its content off the left side of the viewport; post-fix it
      // wraps and stays fully on-screen.
      const geometry = await page.locator(".export-status-error").evaluate((el) => {
        const longMessage = "壞掉的效果清單：" + "元素｢el-speaker｣缺少 data-comot-media 屬性，這是一段刻意加長、含有換行的合成錯誤訊息，用來驗證錯誤區塊在極端長度下仍完整落在畫面內。\n第二行：".repeat(4);
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

describe("截圖比對：Export 面板（#210 條件 3）", () => {
  it("基準截圖：面板展開（export-panel-open）", async () => {
    const started: StartedServer = await startServerFor({ deckDir: exportDeckDir, prefix: "export-gui-shot-open" });
    try {
      const page = await openApp(browser, started.server);
      openPages.push(page);
      await page.getByRole("button", { name: "Export" }).click();
      await page.getByRole("menu").waitFor({ timeout: 5_000 });
      await settleForScreenshot(page);
      await compareScreenshot(page, {
        name: "export-panel-open",
        baselineDir,
        clip: { x: 0, y: 0, width: 1440, height: 200 },
      });
    } finally {
      await started.cleanup();
    }
  }, 60_000);

  it("基準截圖：匯出進行中（export-panel-progress）", async () => {
    const manyFrameDeckDir = await buildManyFrameDeck();
    try {
      const started: StartedServer = await startServerFor({
        deckDir: manyFrameDeckDir,
        prefix: "export-gui-shot-progress",
      });
      try {
        const page = await openApp(browser, started.server);
        openPages.push(page);

        await page.getByRole("button", { name: "Export" }).click();
        await page.locator(".export-menu-item", { hasText: "One page per animation step" }).click();
        // 45 個畫格（15 張投影片 × 3 格）給截圖足夠的時間視窗——不等待完成，
        // 只等進度區真的出現「匯出中」文字。
        await expect.poll(async () => (await page.locator(".export-status").textContent()) ?? "", { timeout: 10_000 }).toContain("匯出中");
        await settleForScreenshot(page);
        await compareScreenshot(page, {
          name: "export-panel-progress",
          baselineDir,
          clip: { x: 0, y: 0, width: 1440, height: 200 },
        });
      } finally {
        await started.cleanup();
      }
    } finally {
      await rm(manyFrameDeckDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
});
