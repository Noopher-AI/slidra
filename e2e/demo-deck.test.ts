import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Locator } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Issue #23's own acceptance criterion, verbatim: "驗收標準不是測試全綠，
 * 是那份手寫的簡報真的播得出來。三頁、有淡入、有影片、有音檔，按方向鍵
 * 一路走到底，作者沒有離開過畫面。" That sentence describes the minimum
 * SHAPE a hand-written deck must demonstrate (fade, video, audio, one
 * continuous keyboard walkthrough) — it is not a page-count requirement
 * on this specific `demo/` directory. `demo/` predates this ticket and
 * was already three pages before this ticket touched it, each page
 * carrying its own manual-acceptance purpose from an earlier ticket
 * (#25 pagination, #11/#13 assets, #28 the effect list). This ticket
 * added a fourth page for the media effects rather than overloading one
 * of those three with a second, unrelated acceptance purpose (reasoning
 * recorded in this ticket's report; the coordinator reviewed and kept
 * this shape at the Codex review gate, round 1 — the four-page choice is
 * the coordinator's call, not something loosened unilaterally by this
 * test's author). This test packs the repo's real `demo/` directory (not
 * a copy under `e2e/fixtures/`), opens it exactly the way
 * `quick_start.sh` does for a human, and walks the whole thing with real
 * `page.keyboard.press` calls — one continuous run from slide 1 to the
 * last step of slide 4, never leaving play mode. If a hand edit to
 * `demo/` ever breaks the walkthrough, this test goes red instead of the
 * breakage sitting undiscovered until a human happens to run
 * quick_start.sh.
 *
 * No autoplay-policy override: the real ArrowRight keypress below is the
 * real user gesture `play()` relies on.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let server: RunningServer;
let presentationId: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireBuilt(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-demo-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-demo-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  registry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "demo.comot");
  await packDirectory(demoDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  presentationId = opened.data!.id;

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

  server = await startServe({ registry, presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.CO_MOTION_HOME;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

// Same reasoning as e2e/player-mode.test.ts: play mode hides elements with
// CSS opacity, and Playwright's isVisible() ignores opacity, so the check
// has to read computed opacity itself.
async function opacityOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).opacity);
}
async function expectVisible(locator: Locator, timeout = 30_000): Promise<void> {
  await expect.poll(() => opacityOf(locator).catch(() => "0"), { timeout }).not.toBe("0");
}
async function expectHidden(locator: Locator, timeout = 30_000): Promise<void> {
  await expect.poll(() => opacityOf(locator).catch(() => "0"), { timeout }).toBe("0");
}

// Same reasoning as e2e/player-media.test.ts's waitForPlayerFocus: the
// sandbox attribute flips to allow-scripts before the fresh play document
// has fetched, parsed and run the runtime, so an ArrowRight fired before
// canvas.ts's "ready" handshake lands goes nowhere.
async function waitForPlayerFocus(page: import("playwright").Page): Promise<void> {
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");
  await expect.poll(() => page.locator(".player-focus-notice").count(), { timeout: 10_000 }).toBe(0);
}

it("驗收簡報：一次連續的方向鍵推進走完四頁，再一路退回第 1 頁的起點——換頁、appear、淡入、影片開始播放、音檔開始播放、逐步倒退、跨頁倒退，作者沒有離開過畫面", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");

  await expect
    .poll(() => playFrame().locator("#el-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("驗收用簡報");

  await page.locator('button:has-text("播放")').click();
  await waitForPlayerFocus(page);

  // 第 1 頁沒有效果，按一次方向鍵直接換到第 2 頁。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => playFrame().locator("#el-asset-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 2 頁：資產");

  // 第 2 頁也沒有效果，再按一次直接換到第 3 頁（效果清單頁）。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => playFrame().locator("#el-effects-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 3 頁：效果清單");

  const stepOne = playFrame().locator("#el-step-one");
  const stepTwo = playFrame().locator("#el-step-two");
  const stepThree = playFrame().locator("#el-step-three");
  await expectHidden(stepOne);
  await expectHidden(stepTwo);
  await expectHidden(stepThree);

  await page.keyboard.press("ArrowRight");
  await expectVisible(stepOne);
  await expectHidden(stepTwo);

  await page.keyboard.press("ArrowRight");
  await expectVisible(stepTwo);
  await expectHidden(stepThree);

  await page.keyboard.press("ArrowRight");
  await expectVisible(stepThree);

  // 第 3 頁走完，再按一次換到第 4 頁（影音頁）。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => playFrame().locator("#el-media-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 4 頁：影音");
  // 換頁是一次 srcdoc 重新載入 (ADR-0010)：runtime 要重新完成 ready 交握
  // 才會套用隱藏，也才會重新掛上鍵盤監聽。
  await waitForPlayerFocus(page);

  const caption = playFrame().locator("#el-media-caption");
  await expectHidden(caption);

  // 淡入.
  await page.keyboard.press("ArrowRight");
  await expectVisible(caption);

  // 影片開始播放：對齊佔位元素，且真的在解碼、真的在前進，不只是 play() resolve。
  const placeholderRect = await playFrame()
    .locator("#el-video-placeholder")
    .evaluate((el) => el.getBoundingClientRect().toJSON());

  await page.keyboard.press("ArrowRight");
  const video = playFrame().locator("video");
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 10_000 }).toBeGreaterThan(0);
  const videoT0 = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(videoT0);
  expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);

  const videoRect = await video.evaluate((el) => el.getBoundingClientRect().toJSON());
  expect(videoRect.left).toBeCloseTo(placeholderRect.left, 0);
  expect(videoRect.top).toBeCloseTo(placeholderRect.top, 0);
  expect(videoRect.width).toBeCloseTo(placeholderRect.width, 0);
  expect(videoRect.height).toBeCloseTo(placeholderRect.height, 0);

  // 音檔開始播放：與影片同時在播，同樣看 currentTime 真的前進.
  await page.keyboard.press("ArrowRight");
  const audio = playFrame().locator("audio");
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState), { timeout: 10_000 }).toBeGreaterThan(0);
  const audioT0 = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(audioT0);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);

  // 影片仍在播——推進到音檔那一步不會把先前的媒體停掉。
  expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);

  // 已經是整份簡報的最後一步：再按一次不動、不當機。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => playFrame().locator("#el-media-title").textContent().catch(() => null))
    .toBe("第 4 頁：影音");

  // --- 反向走：issue #46 的驗收條件是這個往前走的鏡像——從第 4 頁最後一步
  // 一路按方向鍵左退回第 1 頁的起點，全程沒有離開畫面、沒有聲音、沒有錯誤。
  // 接著往前走的狀態繼續（此時仍在第 4 頁、影片與音檔都在播放），而不是另開
  // 一個 it 重新正向走一次：這樣可以驗證retreat 是接續 currentStep 的狀態
  // 退，不是從頭來過，也讓這個檔案維持一條連續、可讀的驗收故事。

  // 退一步：只退回第 4 頁的「淡入」那一步，還在第 4 頁，不是整頁換走。
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => playFrame().locator("#el-media-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 4 頁：影音");
  await expectVisible(caption);
  // 退一步的重播不重播媒體（design doc 的既定決策）：影片、音檔的 overlay
  // 元素被整個拆除，不是暫停——沒有殘留的播放中媒體。
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);

  // 再退一步：回到第 4 頁的第一步（caption 淡入那一步本身），還在第 4 頁。
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => playFrame().locator("#el-media-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 4 頁：影音");
  await expectVisible(caption);
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);

  // 第 4 頁已經退到第一步，再退一步跨頁：回到第 3 頁，且第 3 頁以「整頁跑完」
  // 的樣子呈現——三個步驟全部已經套用，不是它的開頭。
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => playFrame().locator("#el-effects-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 3 頁：效果清單");
  await waitForPlayerFocus(page);
  const stepOneBack = playFrame().locator("#el-step-one");
  const stepTwoBack = playFrame().locator("#el-step-two");
  const stepThreeBack = playFrame().locator("#el-step-three");
  await expectVisible(stepOneBack);
  await expectVisible(stepTwoBack);
  await expectVisible(stepThreeBack);

  // 「只退一步」的關鍵斷言：退一步只讓第三行消失，前兩行仍然可見。
  await page.keyboard.press("ArrowLeft");
  await expectVisible(stepOneBack);
  await expectVisible(stepTwoBack);
  await expectHidden(stepThreeBack);

  // 再退一步：只剩第一行可見。
  await page.keyboard.press("ArrowLeft");
  await expectVisible(stepOneBack);
  await expectHidden(stepTwoBack);

  // 第 3 頁退到開頭，再退一步跨頁：回到第 2 頁（這頁沒有效果，整頁跑完等於
  // 它平常的樣子）。
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => playFrame().locator("#el-asset-title").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 2 頁：資產");
  await waitForPlayerFocus(page);

  // 第 2 頁沒有任何效果步驟：一按就直接跨頁退回第 1 頁。
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => playFrame().locator("#el-subtitle").textContent().catch(() => null), { timeout: 30_000 })
    .toBe("第 1 頁：換頁、即時預覽");
  await waitForPlayerFocus(page);

  // 已經是整份簡報最開頭：再按一次不動、不當機。
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => playFrame().locator("#el-subtitle").textContent().catch(() => null))
    .toBe("第 1 頁：換頁、即時預覽");
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => playFrame().locator("#el-subtitle").textContent().catch(() => null))
    .toBe("第 1 頁：換頁、即時預覽");

  // 全程沒有任何一則錯誤浮出來，也沒有任何媒體還在播放。
  expect(pageErrors).toEqual([]);
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);
});
