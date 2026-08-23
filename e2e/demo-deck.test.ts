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
 * 一路走到底，作者沒有離開過畫面。" This test packs the repo's real `demo/`
 * directory (not a copy under `e2e/fixtures/`), opens it exactly the way
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

it("驗收簡報：一次連續的方向鍵推進走完四頁——換頁、appear、淡入、影片開始播放、音檔開始播放，作者沒有離開過畫面", async () => {
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

  expect(pageErrors).toEqual([]);
});
