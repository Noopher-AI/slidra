import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { requireBuilt } from "./helpers/launch.js";
import { loadPdf } from "./helpers/pdf.js";

/**
 * `co-motion export` (#210 條件 2/4, NOOP-93 §4.3/§4.5). Spawns the real
 * `bin/co-motion.js` (§6.2's "公開邊界二" — never `runExportCli` called
 * in-process, that would skip the exact bin-dispatch branch this ticket
 * had to get right) and reads the produced PDF through `pdf.ts`'s
 * `pdf.js`-backed helper (§6.2's "公開邊界三" — never asserting on PDF
 * bytes/internal structure directly).
 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(rootDir, "packages/cli/bin/co-motion.js");
const coMotionBinPath = path.join(rootDir, "target/release/co-motion");
const exportDeckDir = path.join(rootDir, "e2e/fixtures/export-deck");
const brokenEffectsDeckDir = path.join(rootDir, "e2e/fixtures/broken-effects-deck");
const backdropFilterDeckDir = path.join(rootDir, "e2e/fixtures/backdrop-filter-deck");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [binPath, ...args],
      { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
  });
}

let browser: Browser;

beforeAll(async () => {
  await requireBuilt(rootDir);
  await stat(path.join(rootDir, "packages/web/dist/export.html"));
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser.close();
});

let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-export-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-export-files-"));
  registry = createDefaultRegistry();
  // openFixture() below dispatches "open" in-process (this test's own
  // process), which resolves CO_MOTION_HOME itself — it must see the same
  // home the spawned `co-motion export` child is given via `env()`, or the
  // two processes register/read from two different homes entirely.
  process.env.CO_MOTION_HOME = coMotionHome;
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function env(): NodeJS.ProcessEnv {
  // [E4.T9]/F7: `co-motion export`'s `runExportCli` now spawns the Rust
  // binary itself (`loadProject`) — in production this is always set by
  // the Rust launcher before it execs into this same Node entry point
  // (`crates/co-motion/src/fallback.rs:40`), but this test spawns
  // `packages/cli/bin/co-motion.js` directly (the "public boundary two"
  // the module comment above names), bypassing that launcher entirely.
  return { ...process.env, CO_MOTION_HOME: coMotionHome, CO_MOTION_BIN: coMotionBinPath };
}

async function openFixture(deckDir: string): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(deckDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

describe("argv validation (#210 條件 2, NOOP-93 §4.3's table) — no browser needed, fails before ever touching Playwright", () => {
  it("缺少 presentation-id", async () => {
    const result = await runCli(["export", "--format", "pdf"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("命令 export 缺少參數：presentation-id");
  });

  it("缺少 --format", async () => {
    const result = await runCli(["export", "some-id"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("命令 export 缺少參數：--format");
  });

  it("--format 不是 pdf/pdf-frames 之一（大小寫不寬容）", async () => {
    const result = await runCli(["export", "some-id", "--format", "PDF"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("--format 必須是下列其中一個值：pdf、pdf-frames");
  });

  it("--format pptx 也被拒絕（不是本票支援的格式）", async () => {
    const result = await runCli(["export", "some-id", "--format", "pptx"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("--format 必須是下列其中一個值：pdf、pdf-frames");
  });

  it("--out 缺少值", async () => {
    const result = await runCli(["export", "some-id", "--format", "pdf", "--out"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("--out 缺少值");
  });

  it("id 不存在", async () => {
    const result = await runCli(["export", "no-such-id", "--format", "pdf"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("找不到識別碼對應的簡報：no-such-id");
  });
});

describe("匯出成功（#210 條件 2/4）", () => {
  it("--format pdf：每張投影片一頁", async () => {
    const id = await openFixture(exportDeckDir);
    const outPath = path.join(comotDir, "out.pdf");
    const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`已匯出：${outPath}（3 頁）`);

    const pdfBytes = await readFile(outPath);
    const info = await loadPdf(browser, pdfBytes);
    try {
      expect(info.numPages).toBe(3);
    } finally {
      await info.close();
    }
  }, 60_000);

  it("--format pdf-frames：頁數 = Σ(步數+1)（NOOP-93 §4.5）", async () => {
    const id = await openFixture(exportDeckDir);
    const outPath = path.join(comotDir, "out-frames.pdf");
    const result = await runCli(["export", id, "--format", "pdf-frames", "--out", outPath], { env: env() });

    expect(result.code).toBe(0);
    // export-deck 的步數是 [0, 2, 1] → Σ(步數+1) = 1 + 3 + 2 = 6。
    expect(result.stdout).toContain(`已匯出：${outPath}（6 頁）`);
    // 進度輸出：至少看得到開始行與一行進度（不要求每一格都印出，見
    // export/render.ts 的輪詢註解）。
    expect(result.stdout).toContain("匯出開始：pdf-frames，共 6 格");
    expect(result.stdout).toMatch(/進度：\d+\/6/);

    const pdfBytes = await readFile(outPath);
    const info = await loadPdf(browser, pdfBytes);
    try {
      expect(info.numPages).toBe(6);

      // 逐幀順序：第 1 頁 = 投影片 1（0 步驟，僅 1 格）；第 2-4 頁 = 投影片 2
      // 的 3 格（開場、步驟一、步驟一+二）；第 5-6 頁 = 投影片 3 的 2 格
      // （開場、唯一步驟）。第 2 頁（投影片 2 開場，兩個 enter 元素都還沒
      // 出現）與第 4 頁（投影片 2 最終狀態，兩個 enter 元素都出現）必須
      // 不同，證明逐幀推進確實套用了 startStep，而不是每格都輸出同一個畫面。
      const openingRaster = await info.rasterizePage(1);
      const finalRaster = await info.rasterizePage(3);
      expect(openingRaster.equals(finalRaster)).toBe(false);
    } finally {
      await info.close();
    }
  }, 60_000);

  it("--out 省略時，寫到目前工作目錄的 <name>.pdf", async () => {
    const id = await openFixture(exportDeckDir);
    // realpath: macOS's tmpdir is a symlink (/var → /private/var) and the
    // CLI prints the resolved path.
    const workDir = await realpath(await mkdtemp(path.join(tmpdir(), "co-motion-export-cwd-")));
    try {
      const result = await runCli(["export", id, "--format", "pdf"], { env: env(), cwd: workDir });
      expect(result.code).toBe(0);
      const expectedPath = path.join(workDir, "匯出測試簡報.pdf");
      expect(result.stdout).toContain(`已匯出：${expectedPath}（3 頁）`);
      const stats = await stat(expectedPath);
      expect(stats.isFile()).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it("同名輸出檔案直接覆寫", async () => {
    const id = await openFixture(exportDeckDir);
    const outPath = path.join(comotDir, "overwrite.pdf");
    await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });
    const firstBytes = await readFile(outPath);
    expect(firstBytes.length).toBeGreaterThan(0);

    const second = await runCli(["export", id, "--format", "pdf-frames", "--out", outPath], { env: env() });
    expect(second.code).toBe(0);
    const secondBytes = await readFile(outPath);
    const info = await loadPdf(browser, secondBytes);
    try {
      expect(info.numPages).toBe(6); // pdf-frames 的頁數，證明真的被覆寫成第二次的內容
    } finally {
      await info.close();
    }
  }, 60_000);
});

describe("失敗時不產生半份 PDF（#210 條件 2）", () => {
  it("簡報沒有投影片", async () => {
    const emptyDeckDir = await mkdtemp(path.join(tmpdir(), "co-motion-export-empty-"));
    try {
      await mkdir(path.join(emptyDeckDir, "slides"), { recursive: true });
      await mkdir(path.join(emptyDeckDir, "assets"), { recursive: true });
      await writeFile(
        path.join(emptyDeckDir, "project.json"),
        JSON.stringify({ formatVersion: 1, name: "空白簡報", canvas: { width: 1280, height: 720 }, slides: [] }),
      );
      const id = await openFixture(emptyDeckDir);
      const outPath = path.join(comotDir, "should-not-exist.pdf");
      const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });

      expect(result.code).toBe(1);
      expect(result.stderr.trim()).toBe("簡報沒有投影片");
      await expect(stat(outPath)).rejects.toThrow();
    } finally {
      await rm(emptyDeckDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it("投影片的效果清單壞掉時，exit 1、原始錯誤訊息、不產生檔案", async () => {
    const id = await openFixture(brokenEffectsDeckDir);
    const outPath = path.join(comotDir, "should-not-exist-either.pdf");
    const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });

    expect(result.code).toBe(1);
    // slides/001.svg 的第一個（也是唯一一個）壞損：media 效果缺少
    // data-comot-media（player-plan.ts 的 mediaCuesFor 丟出的原文）。
    expect(result.stderr).toContain("el-speaker");
    expect(result.stderr).toContain("data-comot-media");
    await expect(stat(outPath)).rejects.toThrow();
  }, 60_000);
});

describe("已知限制：backdrop-filter 不會出現在匯出的 PDF（NOOP-93 §4.6）", () => {
  // 這是在記錄一個已知限制，不是在驗證正確行為；哪天 Chromium 支援了，
  // 這個測試會紅，那時把它改成相反的斷言（見 export/render.ts 的 page.pdf()
  // 呼叫處與 §4.6 的四步記錄方式）。
  //
  // 方法：backdrop-filter-deck 兩張投影片除了「有沒有 backdrop-filter」
  // 以外完全相同（見該 fixture 的兩份 .svg）。把兩張都匯出成 PDF 的一頁，
  // 光柵化後比對——如果 backdrop-filter 曾經在某次 Chromium 更新後開始在
  // 列印路徑生效，兩頁會出現實質像素差異，這裡就會先變紅，而不是被誤判
  // 成通過。
  //
  // 比對用 pixelmatch 容忍度，不是逐位元組相等：本輪在這個 pod 實測發現，
  // 即使兩頁在視覺上（pixelmatch 逐像素比對，預設容忍度）完全相同，兩張
  // PNG 的原始位元組仍可能不同（canvas 光柵化路徑的浮點/抗鋸齒非決定性，
  // 與 backdrop-filter 本身無關）——跟 e2e/helpers/screenshot.ts 的
  // compareScreenshot 處理「渲染敏感比對」的方式一致，同一個理由。
  it("有無 backdrop-filter 的兩張投影片，匯出 PDF 光柵化後視覺上相同", async () => {
    const id = await openFixture(backdropFilterDeckDir);
    const outPath = path.join(comotDir, "backdrop.pdf");
    const result = await runCli(["export", id, "--format", "pdf", "--out", outPath], { env: env() });
    expect(result.code).toBe(0);

    const pdfBytes = await readFile(outPath);
    const info = await loadPdf(browser, pdfBytes);
    try {
      expect(info.numPages).toBe(2);
      const withBackdropFilter = PNG.sync.read(await info.rasterizePage(0));
      const withoutBackdropFilter = PNG.sync.read(await info.rasterizePage(1));
      expect(withBackdropFilter.width).toBe(withoutBackdropFilter.width);
      expect(withBackdropFilter.height).toBe(withoutBackdropFilter.height);
      const diff = new PNG({ width: withBackdropFilter.width, height: withBackdropFilter.height });
      const diffPixels = pixelmatch(
        withBackdropFilter.data,
        withoutBackdropFilter.data,
        diff.data,
        withBackdropFilter.width,
        withBackdropFilter.height,
        { threshold: 0.1 },
      );
      expect(diffPixels).toBe(0);
    } finally {
      await info.close();
    }
  }, 60_000);
});
