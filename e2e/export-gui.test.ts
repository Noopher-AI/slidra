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

/**
 * GUI Export 面板 (#210 條件 3/4，NOOP-93 §4.7)。
 *
 * `export-deck`（3 張投影片、6 個逐幀畫格）拿來驗證「按下格式後有進度、
 * 完成後可下載、CLI 與 GUI 產出同一份」；截圖比對的「進度中」情境改用一份
 * 這裡動態產生、有更多畫格的簡報（見 buildManyFrameDeck），單純是為了給
 * Playwright 足夠的時間視窗真的抓到「還在進行中」的畫面——用 6 格的
 * export-deck 曾經在本機整個匯出於截圖指令發出前就已經跑完。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const exportDeckDir = path.join(rootDir, "e2e/fixtures/export-deck");
const baselineDir = path.join(e2eDir, "__screenshots__/export");
const binPath = path.join(rootDir, "packages/cli/bin/co-motion.js");

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
  const dir = await mkdtemp(path.join(tmpdir(), "co-motion-export-gui-deck-"));
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
    execFile("node", [binPath, ...args], { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
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
    // 整個匯出完，看不出進度真的有在動。
    const manyFrameDeckDir = await buildManyFrameDeck();
    try {
      const started: StartedServer = await startServerFor({ deckDir: manyFrameDeckDir, prefix: "export-gui-parity" });
      try {
        const page = await openApp(browser, started.server);
        openPages.push(page);

        await page.getByRole("button", { name: "Export" }).click();
        await page.getByRole("menu").waitFor({ timeout: 5_000 });
        await page.locator(".export-menu-item", { hasText: "One page per animation step" }).click();

        // 面板點擊後關閉，進度區出現，且 n 至少變動過一次（§4.7 驗收語氣：
        // 「n 至少變動過一次」——不要求逐格都被看到，只要求不是從頭到尾都是
        // 同一個數字，或乾脆完成前一格都沒看到）。斷言至少看過兩個相異的
        // n：只看過「有沒有出現匯出中字樣」分不出「n 真的在跳」跟「running
        // 事件帶著 0/N 出現一次、之後直接跳完成」。
        const statusLocator = page.locator(".export-status");
        const seenTexts = new Set<string>();
        await expect
          .poll(
            async () => {
              const text = await statusLocator.textContent().catch(() => null);
              if (text) seenTexts.add(text.trim());
              return Array.from(seenTexts);
            },
            { timeout: 30_000 },
          )
          .toEqual(expect.arrayContaining([expect.stringContaining("下載")]));

        const seenNs = new Set(
          Array.from(seenTexts)
            .map((t) => /匯出中[^0-9]*(\d+)\s*\/\s*\d+/.exec(t)?.[1])
            .filter((n): n is string => n !== undefined),
        );
        expect(seenNs.size).toBeGreaterThan(1);

        const downloadLink = page.locator(".export-status-done a");
        await downloadLink.waitFor({ timeout: 5_000 });
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
