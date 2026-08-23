import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Issue #23 quotes the spec verbatim: "遇到未實作的家族、效果或起始方式，
 * 拋錯並在畫面上說明，不要靜默忽略." Nothing in the repo tested the DOM
 * side of that sentence — packages/web/src/canvas.ts throws and surfaces
 * `error` (unit-tested indirectly through effects.ts/player-plan.ts), but
 * whether an author actually SEES a message, with enough detail to find
 * the broken line, was never checked end to end. This file closes that
 * gap with a hand-written broken fixture
 * (`e2e/fixtures/broken-effects-deck/`): two slides, two different kinds
 * of damage — one is the exact mistake made while hand-authoring
 * `demo/slides/004.svg` for this same ticket (a `family="media"` effect
 * target missing `data-comot-media`), the other is a `target` that does
 * not resolve to any element on the slide (a very plausible typo: an id
 * renamed without updating the effect list that points at it).
 *
 * Two things this test insists on, per the coordinator's review:
 *   1. The banner text must name the actual broken thing (element id /
 *      attribute name), not just say "something went wrong" — otherwise
 *      "說明" is not satisfied, only "拋錯" is.
 *   2. The degraded slide must still render its real content (canvas.ts's
 *      renderPlay catch branch falls back to wrapSlideDocument — the
 *      static, no-runtime render used in view mode) rather than leaving
 *      the frame blank.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/broken-effects-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

async function startServerFor(): Promise<{
  server: RunningServer;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-effecterror-home-"));
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-effecterror-files-"));
  process.env["CO_MOTION_HOME"] = coMotionHome;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "broken-effects-deck.comot");
  await packDirectory(deckDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "此測試不會送出訊息",
    },
  };

  const server = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env["CO_MOTION_HOME"];
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
    },
  };
}

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

it("進入播放時效果清單解析失敗：畫面上出現指名問題所在的錯誤說明，投影片仍以靜態方式顯示原本的內容", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    // 檢視模式：不呼叫 computePlayerPlan，所以第 1 頁在這裡完全正常，
    // 內容就看得到——壞掉的只是效果清單，不是投影片本身。
    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 1 頁：缺少 data-comot-media");

    await page.locator('button:has-text("播放")').click();

    // 進入播放：effects.ts 對第 1 頁的效果清單解析會拋錯（media 效果的
    // 目標缺少 data-comot-media），canvas.ts 把它顯示成畫面上的橫幅。
    const notice = page.locator(".player-error-notice");
    await expect.poll(() => notice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    const noticeText = await notice.first().textContent();
    // 訊息要指名是哪個元素、缺了哪個屬性——不是「發生錯誤」這種空話，
    // 這樣作者才找得到要修哪一行。
    expect(noticeText).toContain("el-speaker");
    expect(noticeText).toContain("data-comot-media");

    // 降級行為要誠實：解析失敗不等於畫面空白，投影片本身的內容仍在。
    const opacityOf = (selector: string) =>
      playFrame()
        .locator(selector)
        .evaluate((el) => getComputedStyle(el).opacity)
        .catch(() => null);
    await expect.poll(() => opacityOf("#el-broken-title")).toBe("1");
    await expect.poll(() => opacityOf("#el-speaker")).toBe("1");

    // 換到第 2 頁（另一種損壞：target 指向不存在的元素）。showSlide()
    // 在播放模式下也能用（沿用 e2e/player-media.test.ts 的既有做法），
    // 播放模式下方向鍵推進在解析失敗時沒有 runtime 可監聽，所以這裡改走
    // 總覽縮圖點擊，而不是按方向鍵。
    await page.locator('button[aria-label="第 2 頁"]').click();

    await expect
      .poll(() => playFrame().locator("#el-broken-title-2").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 2 頁：指向不存在的元素");

    const noticeText2 = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText2).toContain("el-does-not-exist");

    await expect.poll(() => opacityOf("#el-broken-title-2")).toBe("1");
    await expect.poll(() => opacityOf("#el-real")).toBe("1");
  } finally {
    await cleanup();
  }
});
