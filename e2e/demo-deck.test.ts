import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Locator } from "playwright";
import { PNG } from "pngjs";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { loadPdf } from "./helpers/pdf.js";
import { workDirFor } from "../packages/server/src/comotion/home.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

const execFileAsync = promisify(execFile);

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
const coMotionBin = path.join(rootDir, "target/release/comotion");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
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
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);

  coMotionHome = await mkdtemp(path.join(tmpdir(), "comotion-e2e-demo-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "comotion-e2e-demo-files-"));
  process.env.COMOTION_HOME = coMotionHome;
  // [E4.T9]/F7: comotion serve now spawns the Rust binary for every read/write.
  process.env.COMOTION_BIN = coMotionBin;

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

  server = await startServe({ presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.COMOTION_HOME;
  delete process.env.COMOTION_BIN;
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

// Since #72 every element is a `<g>` container wrapping its primitives, and
// the `id` lives on that container (ADR-0012). `textContent` on a container
// therefore includes the indentation between its tags, so every text
// assertion below reads through this trim rather than comparing raw
// textContent. The alternative — pointing each locator at the inner
// `<text>` — would stop the assertions from proving that the id resolves to
// the element at all, which is the thing conversion changed.
async function textOf(locator: Locator): Promise<string | null> {
  const text = await locator.textContent();
  return text === null ? null : text.trim();
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

// 退回時「保留下來」或「重播出來」的元素該長什麼樣：opacity 剛好是 1（不是
// 「不等於 0」——淡入動畫途中也會不等於 0），而且沒有任何 transition。
// resetToStep() 的重播路徑對每個碰到的元素都明確寫死 transition: none 並把
// opacity 設成 1 !important，所以這兩個值都是「已經」成立，不是「終將」成立；
// 這個函式刻意不輪詢，輪詢會把一個錯誤地重播的淡入等到跑完再放行。
async function expectReplayedInstantly(locator: Locator): Promise<void> {
  const computed = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return { opacity: style.opacity, transitionDuration: style.transitionDuration };
  });
  expect(computed).toEqual({ opacity: "1", transitionDuration: "0s" });
}

// App.tsx renders the runtime's reported errors as `.player-error-notice`
// in the *parent* document (not inside the play iframe) — this is what
// "浮出來" means in issue #46's acceptance wording. `page.on("pageerror")`
// only catches uncaught exceptions in the page and would never see this
// banner, since the runtime reports errors to the parent over postMessage.
// A fresh renderPlay() on a page change clears the banner, so this must be
// polled after every single reverse key press, not only once at the end.
async function expectNoErrorBanner(page: import("playwright").Page): Promise<void> {
  await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBe(0);
}

// Same reasoning as e2e/player-media.test.ts's waitForPlayerFocus: the
// sandbox attribute is "allow-scripts" in both view and play mode (ADR-0011),
// so it can no longer distinguish "play mode has started" from "still
// viewing". Wait for .titlebar (view mode's shell chrome) to unmount instead,
// which is what actually flips only on entering play. Only once that has
// happened does waiting on the play bar's `data-player-focus` mean anything
// (#68 replaced the focus notice this used to wait on with that attribute).
async function waitForPlayerFocus(page: import("playwright").Page): Promise<void> {
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expect.poll(() => page.locator('.play-bar[data-player-focus="true"]').count(), { timeout: 10_000 }).toBe(1);
}

it("驗收簡報：一次連續的方向鍵推進走完四頁，再一路退回第 1 頁的起點——換頁、appear、淡入、影片開始播放、音檔開始播放、逐步倒退、跨頁倒退，作者沒有離開過畫面", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");

  await expect
    .poll(() => textOf(playFrame().locator("#el-title")).catch(() => null), { timeout: 30_000 })
    .toBe("驗收用簡報");

  await page.locator('.play-button').click();
  await waitForPlayerFocus(page);

  // 第 1 頁沒有效果，按一次方向鍵直接換到第 2 頁。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => textOf(playFrame().locator("#el-asset-title")).catch(() => null), { timeout: 30_000 })
    .toBe("第 2 頁：資產");

  // 第 2 頁也沒有效果，再按一次直接換到第 3 頁（效果清單頁）。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => textOf(playFrame().locator("#el-effects-title")).catch(() => null), { timeout: 30_000 })
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
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null), { timeout: 30_000 })
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

  // 影片仍在播——推進到音檔那一步不會把先前的媒體停掉。runtime 對 video 狀態的
  // 收斂是非同步的：機器負載高時，這裡原本「動作完成後立刻同步讀一次 paused」
  // 的讀值時間點可能落在收斂完成之前而偶發假紅。改成等到真正安定的終止條件。
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 })
    .toBe(false);

  // 已經是整份簡報的最後一步：再按一次不動、不當機。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null))
    .toBe("第 4 頁：影音");

  // --- 反向走：issue #46 的驗收條件是這個往前走的鏡像——從第 4 頁最後一步
  // 一路按方向鍵左退回第 1 頁的起點，全程沒有離開畫面、沒有聲音、沒有錯誤。
  // 接著往前走的狀態繼續（此時仍在第 4 頁、影片與音檔都在播放），而不是另開
  // 一個 it 重新正向走一次：這樣可以驗證retreat 是接續 currentStep 的狀態
  // 退，不是從頭來過，也讓這個檔案維持一條連續、可讀的驗收故事。

  // 在反向走開始「之前」就裝好錯誤橫幅的觀察者。expectNoErrorBanner 用的
  // expect.poll(...).toBe(0) 一讀到 0 就回傳，並不會盯滿整個 timeout；而 runtime
  // 是用 postMessage 把錯誤送回父層的（下一個 task 才到），下一次換頁又會重新
  // renderPlay 把橫幅清掉——真的浮出來過的橫幅完全可能被這種輪詢整個錯過。
  // MutationObserver 相反：它記下每一次出現，走完之後再一次檢查記錄是空的。
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __errorBanners: string[] }).__errorBanners = seen;
    const collect = (node: Node): void => {
      if (!(node instanceof Element)) return;
      if (node.matches(".player-error-notice")) seen.push(node.textContent ?? "");
      node.querySelectorAll(".player-error-notice").forEach((el) => seen.push(el.textContent ?? ""));
    };
    collect(document.body);
    new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(collect);
      // 也掃一次當下的 DOM：橫幅節點若已存在、只是文字被改寫，就不會出現在
      // addedNodes 裡。重複記錄無所謂，最後只斷言這份記錄是空的。
      collect(document.body);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const recordedErrorBanners = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __errorBanners: string[] }).__errorBanners);

  // 反向走之前先抓住正在播放的 video/audio 的 element handle。退回時 runtime 會把
  // overlay 元素整個從文件移除，之後 locator 的 count 會是 0——但「DOM 裡沒有這個
  // 節點」不等於「沒有聲音」：一個已經脫離文件的媒體元素仍然可能在出聲，而 count
  // 一樣是 0，測試照樣全綠。抓住 handle 之後就能對元素本身問 paused。
  // 實測（Chromium 151，本機探針）：單純「移除但不呼叫 pause()」抓不到，因為 HTML
  // 規格要求瀏覽器在元素離開文件後的 stable state 自己補上暫停；但若有任何程式碼
  // 在那個自動暫停之後再對這個已脫離的元素呼叫 play()，paused 就會一直是 false，
  // 這時只有下面這兩行會紅，count 依然是 0。
  const videoHandle = await video.elementHandle();
  const audioHandle = await audio.elementHandle();
  if (!videoHandle || !audioHandle) throw new Error("反向走開始前應該要有正在播放的 video 與 audio");

  // 退一步：只退回第 4 頁的「淡入」那一步，還在第 4 頁，不是整頁換走。這是
  // 拆除仍在載入中媒體元素的那一步，也是 AbortError 抑制路徑會跑到的地方，
  // 所以錯誤橫幅的檢查從這一步就要開始，不能只在最後補一次。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null), { timeout: 30_000 })
    .toBe("第 4 頁：影音");
  await expectVisible(caption);
  // 退一步的重播不重播媒體（design doc 的既定決策）：影片、音檔的 overlay
  // 元素被整個拆除，不是暫停——沒有殘留的播放中媒體。
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);
  // 上面兩個 count 只證明節點不在文件裡。這兩行才是「沒有聲音」本身：對那兩個
  // 已經被移除的元素本身問 paused。兩者證明的是不同的事，都要留著。
  expect(await videoHandle.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  expect(await audioHandle.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);

  // 再退一步：回到第 4 頁的第一步（caption 淡入那一步本身），還在第 4 頁。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null), { timeout: 30_000 })
    .toBe("第 4 頁：影音");
  await expectVisible(caption);
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);

  // 第 4 頁已經退到第一步，再退一步跨頁：回到第 3 頁，且第 3 頁以「整頁跑完」
  // 的樣子呈現——三個步驟全部已經套用，不是它的開頭。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-effects-title")).catch(() => null), { timeout: 30_000 })
    .toBe("第 3 頁：效果清單");
  await waitForPlayerFocus(page);
  const stepOneBack = playFrame().locator("#el-step-one");
  const stepTwoBack = playFrame().locator("#el-step-two");
  const stepThreeBack = playFrame().locator("#el-step-three");
  await expectVisible(stepOneBack);
  await expectVisible(stepTwoBack);
  await expectVisible(stepThreeBack);

  // expectVisible 只證明 opacity 不是 "0"——淡入動畫跑到一半也會通過。跨頁退回
  // 的重播必須是「已經跑完、而且從來沒有動畫」：runtime 在 post("ready") 之前就
  // 同步跑完 resetToStep(startStep)（player-runtime.js 的 startStep 區塊），而上面
  // 的 waitForPlayerFocus 是等 ready 交握才回來的，所以此刻讀到的 computed style
  // 就是重播的最終狀態，不需要輪詢。
  await expectReplayedInstantly(stepOneBack);
  await expectReplayedInstantly(stepTwoBack);
  await expectReplayedInstantly(stepThreeBack);

  // 「只退一步」的關鍵斷言：退一步只讓第三行消失，前兩行仍然可見。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expectVisible(stepOneBack);
  await expectVisible(stepTwoBack);
  await expectHidden(stepThreeBack);

  // 上面 expectHidden 用的是輪詢，會等到 opacity 到 0 為止——就算這一步錯誤地
  // 播了淡出動畫，輪詢也只是等動畫跑完再通過，並不能證明「瞬間消失」。這裡
  // 直接讀取瀏覽器算出來的 computed style，不輪詢：resetToStep() 的既定行為
  // 是把 transition 強制設成 "none"、opacity 直接歸零，兩者都必須「已經」成立，
  // 不是「終將」成立。這正是 jsdom 狀態測試看不到、只有真實瀏覽器才能看到的地方。
  expect(await stepThreeBack.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  expect(await stepThreeBack.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");

  // 留下來的前兩行同樣要「已經」是最終狀態。expectVisible 只要求 opacity !== "0"，
  // 一個錯誤地重播了淡入的退步會在動畫途中就通過它；這裡不輪詢、直接讀 computed
  // style，要求 opacity 剛好是 "1" 且完全沒有 transition。上面的 expectHidden
  // 已經證明 resetToStep() 這一輪（同步執行）跑完了，所以此刻讀到的就是最終值。
  await expectReplayedInstantly(stepOneBack);
  await expectReplayedInstantly(stepTwoBack);

  // 再退一步：只剩第一行可見。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expectVisible(stepOneBack);
  await expectHidden(stepTwoBack);

  // 第 3 頁退到開頭，再退一步跨頁：回到第 2 頁（這頁沒有效果，整頁跑完等於
  // 它平常的樣子）。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-asset-title")).catch(() => null), { timeout: 30_000 })
    .toBe("第 2 頁：資產");
  await waitForPlayerFocus(page);

  // 第 2 頁沒有任何效果步驟：一按就直接跨頁退回第 1 頁。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-subtitle")).catch(() => null), { timeout: 30_000 })
    .toBe("第 1 頁：換頁、即時預覽");
  await waitForPlayerFocus(page);

  // 已經是整份簡報最開頭：再按一次不動、不當機。
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-subtitle")).catch(() => null))
    .toBe("第 1 頁：換頁、即時預覽");
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-subtitle")).catch(() => null))
    .toBe("第 1 頁：換頁、即時預覽");

  // 全程沒有任何一則錯誤浮出來，也沒有任何媒體還在播放。
  expect(pageErrors).toEqual([]);
  // 整趟反向走裡，錯誤橫幅一次都沒有出現過——包含那些出現後又被下一次換頁清掉、
  // 逐次輪詢看不到的。這是 issue #46「沒有錯誤浮出來」真正的證據。
  expect(await recordedErrorBanners()).toEqual([]);
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);
  // 這裡不再對 videoHandle / audioHandle 問一次 paused：反向走已經跨頁離開第 4
  // 頁，那份 srcdoc 文件連同它的 JS 執行環境整個被換掉了（handle 會直接丟
  // "Execution context was destroyed"），元素本身已不可能還在出聲。「移除但沒有
  // pause」這個缺陷會在上面那次同頁退步就被抓到，那時文件還在。
});

// --- #72 -----------------------------------------------------------------

/**
 * AC 7, 把轉檔後的投影片直接丟進瀏覽器打開: no CoMotion, no server, no
 * injected runtime — just `file://` and the browser's own SVG renderer.
 * This is the check that the container form is plain, native SVG and not
 * something only CoMotion knows how to draw.
 */
it("轉檔後的投影片用 file:// 直接開，靜態畫面正確：文字、位置、相對路徑的圖片都對", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    const failedRequests: string[] = [];
    page.on("requestfailed", (request) => failedRequests.push(request.url()));
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));

    await page.goto(`file://${path.join(demoDir, "slides/001.svg")}`);

    // The id resolves to the element, and the element carries the text.
    expect((await page.locator("#el-title").textContent())?.trim()).toBe("驗收用簡報");
    expect((await page.locator("#el-subtitle").textContent())?.trim()).toBe("第 1 頁：換頁、即時預覽");

    // Geometry: the title is centred horizontally (text-anchor="middle" at
    // x=640 on a 1280-wide viewBox) and sits above the subtitle (y=330 vs
    // y=420). Both are read off the rendered box, not off the file.
    const titleBox = (await page.locator("#el-title").boundingBox())!;
    const subtitleBox = (await page.locator("#el-subtitle").boundingBox())!;
    const viewport = page.viewportSize()!;
    // The centre is measured off the *rendered* glyph box, so it carries the
    // platform's font metrics: the same correctly-centred title measures 640.0
    // on macOS and 639.0 on Linux CI. A 0.5px tolerance is a font-rasterization
    // assertion in disguise, not a layout one — the same cross-platform problem
    // the appearance baselines have (see AGENTS.md, 視覺回歸的把關分工). A few
    // pixels of slack still leaves no room for a real regression: losing
    // `text-anchor="middle"` shifts the centre by half the title's width,
    // hundreds of pixels.
    expect(Math.abs(titleBox.x + titleBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(titleBox.y).toBeLessThan(subtitleBox.y);
    expect(titleBox.height).toBeGreaterThan(0);

    // Slide 2's <image href="../assets/photo.svg"> is a relative path with
    // no <base> to help it here — under file:// the browser has to resolve
    // it against the slide's own directory and actually fetch it.
    await page.goto(`file://${path.join(demoDir, "slides/002.svg")}`);
    await expect.poll(() => requestedUrls.filter((url) => url.endsWith("/assets/photo.svg")).length).toBeGreaterThan(0);
    expect(failedRequests).toEqual([]);
    const photoBox = (await page.locator("#el-photo").boundingBox())!;
    expect(photoBox.width).toBeGreaterThan(0);
    expect(photoBox.height).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

/**
 * AC 5, 轉檔後畫面像素級不變 — the direct form of the evidence.
 *
 * The five committed baseline screenshots (appearance/stage/grid/play/
 * selection) already watch `demo/` from outside this unit's write boundary,
 * which is what makes them honest. This test proves the same property about
 * conversion itself rather than about one particular deck: it renders a
 * hand-written BARE slide and its own converted output in the same browser,
 * at the same viewport, and compares the two PNGs byte for byte. No new
 * baseline PNG is committed — the two shots are each other's baseline.
 */
it("同一份投影片轉檔前後，瀏覽器畫出來的像素完全相同", async () => {
  const bare =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
    '  <rect x="0" y="0" width="1280" height="720" fill="#101418"/>\n' +
    '  <text id="el-title" data-comot-name="標題" x="640" y="200" text-anchor="middle" font-size="86" fill="#f4f6f8">轉檔前後</text>\n' +
    '  <image id="el-photo" href="assets/photo.svg" x="490" y="260" width="300" height="300"/>\n' +
    '  <line x1="100" y1="620" x2="1180" y2="620" stroke="#c66" stroke-width="6"/>\n' +
    '  <path d="M100 660 L200 700 L100 700 Z" fill="#9aa7b4"/>\n' +
    '  <g id="el-icon" data-comot-name="圖示">\n' +
    '    <circle cx="1100" cy="670" r="30" fill="#c66"/>\n' +
    '  </g>\n' +
    "</svg>\n";

  const dir = await mkdtemp(path.join(tmpdir(), "comotion-e2e-pixel-"));
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    // `normaliseSlideSvg`/`generateElementId` (the TypeScript engine's own
    // conversion functions) no longer exist ([E4.T12]) — the only public
    // door to the same conversion is now `comotion convert`, which acts on
    // an already-open presentation's slide file on disk, not a raw string.
    // A throwaway presentation under the same `registry`/`COMOTION_HOME`
    // this file's `beforeAll` already set up (never the shared 4-page demo
    // presentation the walkthrough tests below depend on) gives `convert`
    // something to act on: write `bare` as its `slides/001.svg`, run
    // `convert`, read the result back.
    const convertComotPath = path.join(dir, "convert-test.comot");
    const newResult = await registry.dispatch("new", { path: convertComotPath, name: "轉檔前後像素比對" });
    expect(newResult.ok).toBe(true);
    const opened = await registry.dispatch<{ id: string }>("open", { path: convertComotPath });
    const convertTestId = opened.data!.id;
    // `new` creates no slides (ADR-0018); mint slides/001.svg so `convert` has a page to rewrite.
    await registry.dispatch("slide add", { id: convertTestId });
    const workDir = await workDirFor(convertTestId);
    await writeFile(path.join(workDir, "slides/001.svg"), bare, "utf-8");
    const convertResult = await registry.dispatch("convert", { id: convertTestId });
    expect(convertResult.ok).toBe(true);
    const catResult = await registry.dispatch<{ content: string }>("cat", { id: convertTestId, path: "slides/001.svg" });
    expect(catResult.ok).toBe(true);
    const converted = catResult.data!.content;
    // Guard against a tautology: if conversion were a no-op, comparing the
    // two renders would prove nothing at all.
    expect(converted).not.toBe(bare);
    expect(converted).toContain("<g ");

    await mkdir(path.join(dir, "assets"), { recursive: true });
    await copyFile(path.join(demoDir, "assets/photo.svg"), path.join(dir, "assets/photo.svg"));
    await writeFile(path.join(dir, "bare.svg"), bare, "utf-8");
    await writeFile(path.join(dir, "converted.svg"), converted, "utf-8");

    await page.goto(`file://${path.join(dir, "bare.svg")}`);
    await page.evaluate(() => document.fonts.ready);
    const before = await page.screenshot();

    await page.goto(`file://${path.join(dir, "converted.svg")}`);
    await page.evaluate(() => document.fonts.ready);
    const after = await page.screenshot();

    expect(after.equals(before)).toBe(true);
  } finally {
    await page.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Reads the RGB of the pixel at an element's own rendered center, from its own `.screenshot()` (never the surrounding page — that would also catch #120's `<body>` fallback, out of scope here per canvas.ts's own comment). */
function centerRgb(png: PNG): { r: number; g: number; b: number } {
  const x = Math.floor(png.width / 2);
  const y = Math.floor(png.height / 2);
  const index = (png.width * y + x) << 2;
  return { r: png.data[index], g: png.data[index + 1], b: png.data[index + 2] };
}

/**
 * AC 2/4/6 (父票驗收條件 A2), Plan §6.3: demo 四頁的根 `<svg>` 的
 * `background-color` 取代了原本的滿版 `<rect>`（上一個 commit）。這個測試
 * 是四條實際渲染路徑（編輯舞台、左欄縮圖、播放、匯出）的行為契約——每條路
 * 徑都得在自己的包裝文件裡把這個宣告畫成看得見的底色，不是只讓
 * `slide style set` 寫得出這個屬性。
 *
 * 每個量測點都用該元素自己的 `.screenshot()`（不是整頁截圖）：canvas.ts
 * 三個包裝的 `<body>` 背景是白色（#120 的退回色），容器盒比 svg 盒高時底
 * 下會露出白邊（F-01，歸另一票）。只截 svg 自己的框就不會撞進那片白邊，
 * 這個測試因此驗證得到的是「svg 盒本身畫的是設定色」，不是「整個 iframe
 * 沒有白像素」。
 */
it("demo 四頁的頁面底色由根 <svg> 的 background-color 決定：編輯舞台／左欄縮圖／播放／匯出四條路徑量到的都是 #101418，不是白色", async () => {
  for (const slidePath of ["slides/001.svg", "slides/002.svg", "slides/003.svg", "slides/004.svg"]) {
    const markup = await readFile(path.join(demoDir, slidePath), "utf-8");
    expect(markup).not.toContain('width="1280" height="720"');
    expect(markup).toContain('style="background-color:#101418"');
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(server.url);

    const stageSvg = page.frameLocator("iframe.slide-frame").locator("svg").first();
    await expect
      .poll(() => stageSvg.evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => null), {
        timeout: 30_000,
      })
      .toBe("rgb(16, 20, 24)");
    expect(centerRgb(PNG.sync.read(await stageSvg.screenshot()))).toEqual({ r: 16, g: 20, b: 24 });

    const thumbSvg = page.frameLocator('.overview-item[data-index="0"] iframe.overview-frame').locator("svg").first();
    await expect
      .poll(() => thumbSvg.evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => null), {
        timeout: 30_000,
      })
      .toBe("rgb(16, 20, 24)");
    expect(centerRgb(PNG.sync.read(await thumbSvg.screenshot()))).toEqual({ r: 16, g: 20, b: 24 });

    await page.locator(".play-button").click();
    await waitForPlayerFocus(page);
    const playSvg = page.frameLocator("iframe.slide-frame").locator("svg").first();
    await expect
      .poll(() => playSvg.evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => null), {
        timeout: 30_000,
      })
      .toBe("rgb(16, 20, 24)");
    expect(centerRgb(PNG.sync.read(await playSvg.screenshot()))).toEqual({ r: 16, g: 20, b: 24 });
  } finally {
    await page.close();
  }

  const outPath = path.join(comotDir, "background-check.pdf");
  await execFileAsync(coMotionBin, ["export", presentationId, "--format", "pdf", "--out", outPath], {
    env: { ...process.env, COMOTION_HOME: coMotionHome, COMOTION_BIN: coMotionBin },
  });
  const pdfBytes = await readFile(outPath);
  const info = await loadPdf(browser, pdfBytes);
  try {
    const { r, g, b } = centerRgb(PNG.sync.read(await info.rasterizePage(0)));
    // 匯出經過一次 PDF 光柵化，容許 ±2/色階的浮點誤差（與 e2e/export-cli.test.ts
    // 既有的光柵化比對同一套容忍度）。
    expect(Math.abs(r - 16)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 24)).toBeLessThanOrEqual(2);
  } finally {
    await info.close();
  }
}, 60_000);
