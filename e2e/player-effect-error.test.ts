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
 * (`e2e/fixtures/broken-effects-deck/`): five slides, five different
 * kinds of damage —
 *   1. a `family="media"` effect target missing `data-comot-media` (the
 *      exact mistake made while hand-authoring `demo/slides/004.svg` for
 *      this same ticket)
 *   2. a `target` that does not resolve to any element on the slide (a
 *      very plausible typo: an id renamed without updating the effect
 *      list that points at it)
 *   3. an unimplemented `family` value (`build` — [E2.T7] implemented
 *      `emphasis` for real, so this fixture's stand-in for "a family
 *      nothing implements" moved to a value that stays permanently
 *      unimplemented, D4)
 *   4. an unimplemented `effect` value under an otherwise-valid family
 *      (`enter`/`wipe` — plausible if an author assumes PowerPoint-style
 *      transition names just work; `wipe` is deliberately never
 *      implemented, [E2.T7] §2 — this fixture is *why* it never will be)
 *   5. an unimplemented `start` value (`on-hover` — [E2.T7] implemented
 *      `with-previous` for real, D3, so this fixture's stand-in for "a
 *      start nothing implements" moved to a value that stays permanently
 *      unimplemented)
 * Round 1 of the Codex review gate on this ticket found #3–#5 missing:
 * the suite only proved the DOM banner exists for damage it happens to
 * be good at catching, not for the "未實作" half of the spec sentence —
 * exactly the gap this kind of e2e test exists to close.
 *
 * Two things this test insists on, per the coordinator's review:
 *   1. The banner text must name the actual broken thing (element id /
 *      attribute name / unsupported value), not just say "something went
 *      wrong" — otherwise "說明" is not satisfied, only "拋錯" is.
 *   2. The degraded slide must still render its real content (canvas.ts's
 *      renderPlay catch branch falls back to wrapSlideDocument — the
 *      static, no-runtime render used in view mode) rather than leaving
 *      the frame blank.
 *
 * 下面每個 `page.close()` 當初是這樣被診斷出來的：透過加時間戳記的觀測，
 * 重複跑了約 30 次，發現這個檔案大約每 5-8 次就會有 1 次整個卡到 120 秒
 * 的測試逾時上限，卡點是某個 `it()` 呼叫 `cleanup()`（→ `server.close()`）
 * 時，該次測試自己開的那個 page 上，live-reload／chat 的 SSE 連線
 * （在掛載時就急切地開啟——見 App.tsx）還沒關閉。`startServe` 的
 * `close()` 雖然會主動關掉它自己追蹤的串流，但跟任何普通的
 * `http.Server.close()` 一樣，仍然會等待 socket 上其他還開著的連線；
 * 一個沒關閉的 Playwright page，它的連線要一直等到 `afterAll` 裡共用的
 * `browser` 整個關閉才會死掉，於是所有卡住的 `server.close()` 會在那一刻
 * 同時被解除——這正是當初加時間戳觀測時看到的現象。
 *
 * 這個根因後來在 #37 修好了：`packages/server/src/serve.ts` 的
 * `close()` 現在會在 `server.close(cb)` 之後緊接著呼叫
 * `server.closeAllConnections()`，所以即使還有連線開著也不會再卡住關閉。
 * 這一點針對本檔案有實際測量過：把下面每個 `page.close()` 都拿掉後，
 * 單獨連續跑這個檔案 10 次，全部通過、沒有任何一次卡住（每次跑完約
 * 2 秒左右，離會咬人的 120 秒逾時還很遠）。10 次是一個小樣本，對照當初
 * 大約 5-8 次會中一次的機率型 bug 來說，這只能說「這個樣本裡沒有再重
 * 現」，不能證明這個 hang 從此不會再發生。
 *
 * 這個對照組也另外跑過：把同一份拿掉 page.close() 的檔案，搭配還沒套用
 * #37 修復的舊版 `serve.ts`（沒有 `closeAllConnections()`），在同一台機器、
 * 同一個 Node 版本上跑。結果第 3 次就整個卡到 120 秒逾時上限，1 個測試
 * 失敗、3 個通過——也就是說這個 hang 在這台機器、這個 Node 版本上依然會
 * 重現，不是「這台機器現在剛好測不出來了」。因此上面那 10 次乾淨的結果，
 * 是對照一個真的還會發作的失敗模式而得到的，不只是單純沒觀察到失敗而已。
 *
 * 即便如此，這裡仍然刻意保留 `page.close()`：關閉 page 本身就是良好的
 * 收尾習慣，跟伺服器端修好與否無關；而且留著它，將來如果 `close()` 又
 * 出現類似的退化，會在這裡直接變成一個清楚可歸因的失敗，而不是一次
 * 神秘的 120 秒逾時。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/co-motion");
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
  // [E4.T9]/F7: co-motion serve now spawns the Rust binary for every read/write.
  process.env["CO_MOTION_BIN"] = coMotionBin;

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

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env["CO_MOTION_HOME"];
      delete process.env["CO_MOTION_BIN"];
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
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    // 檢視模式：不呼叫 computePlayerPlan，所以第 1 頁在這裡完全正常，
    // 內容就看得到——壞掉的只是效果清單，不是投影片本身。
    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 1 頁：缺少 data-comot-media");

    await page.locator('.play-button').click();

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

    // 換到第 2 頁（另一種損壞：target 指向不存在的元素）。播放模式下方向
    // 鍵推進在解析失敗時沒有 runtime 可監聽，所以改走 #54 控制列的
    // 「下一步」——它接的是 controller.next()（＝showSlide(currentIndex+1)，
    // 換頁不換效果步驟），在播放模式下也能用，不需要任何 runtime 活著。
    await page.locator('.play-bar button[aria-label="下一步"]').click();

    await expect
      .poll(() => playFrame().locator("#el-broken-title-2").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 2 頁：指向不存在的元素");

    const noticeText2 = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText2).toContain("el-does-not-exist");

    await expect.poll(() => opacityOf("#el-broken-title-2")).toBe("1");
    await expect.poll(() => opacityOf("#el-real")).toBe("1");
  } finally {
    // The page (and its live SSE connections to /api/events and
    // /api/chat/stream, opened eagerly on mount — see App.tsx) must be
    // closed BEFORE cleanup()'s server.close(): Node's http.Server.close()
    // waits for every currently open connection to end, and an unclosed
    // page's SSE streams never end on their own. Diagnosed while chasing
    // an intermittent ~1-in-5 full-120s hang in this exact file (see this
    // ticket's report) — closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});

it("進入播放時 family 未實作：畫面上出現指名該 family 值的錯誤說明", async () => {
  const { server, cleanup } = await startServerFor();
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 1 頁：缺少 data-comot-media");

    await page.locator('.play-button').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // 從第 1 頁換到第 3 頁：控制列的「下一步」是換頁（±1），不是跳頁，
    // 所以連按兩次，經過第 2 頁（另一種損壞，見上一個測項）。
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-3").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 3 頁：未實作的 family");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("build");
    expect(noticeText).toContain("尚未實作");

    const opacityOf = (selector: string) =>
      playFrame().locator(selector).evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
    await expect.poll(() => opacityOf("#el-broken-title-3")).toBe("1");
    await expect.poll(() => opacityOf("#el-emphasis-target")).toBe("1");
  } finally {
    // The page (and its live SSE connections to /api/events and
    // /api/chat/stream, opened eagerly on mount — see App.tsx) must be
    // closed BEFORE cleanup()'s server.close(): Node's http.Server.close()
    // waits for every currently open connection to end, and an unclosed
    // page's SSE streams never end on their own. Diagnosed while chasing
    // an intermittent ~1-in-5 full-120s hang in this exact file (see this
    // ticket's report) — closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});

it("進入播放時 effect 未實作：畫面上出現指名該 effect 值的錯誤說明", async () => {
  const { server, cleanup } = await startServerFor();
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 1 頁：缺少 data-comot-media");

    await page.locator('.play-button').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // 從第 1 頁換到第 4 頁：連按三次「下一步」（見上一個測項的說明）。
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-4").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 4 頁：未實作的 effect");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("wipe");
    expect(noticeText).toContain("尚未實作");

    const opacityOf = (selector: string) =>
      playFrame().locator(selector).evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
    await expect.poll(() => opacityOf("#el-broken-title-4")).toBe("1");
    await expect.poll(() => opacityOf("#el-wipe-target")).toBe("1");
  } finally {
    // The page (and its live SSE connections to /api/events and
    // /api/chat/stream, opened eagerly on mount — see App.tsx) must be
    // closed BEFORE cleanup()'s server.close(): Node's http.Server.close()
    // waits for every currently open connection to end, and an unclosed
    // page's SSE streams never end on their own. Diagnosed while chasing
    // an intermittent ~1-in-5 full-120s hang in this exact file (see this
    // ticket's report) — closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});

it("進入播放時 start 未實作：畫面上出現指名該 start 值的錯誤說明", async () => {
  const { server, cleanup } = await startServerFor();
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 1 頁：缺少 data-comot-media");

    await page.locator('.play-button').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // 從第 1 頁換到第 5 頁：連按四次「下一步」（見上一個測項的說明）。
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-5").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 5 頁：未實作的 start");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("on-hover");
    expect(noticeText).toContain("尚未實作");

    const opacityOf = (selector: string) =>
      playFrame().locator(selector).evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
    await expect.poll(() => opacityOf("#el-broken-title-5")).toBe("1");
    await expect.poll(() => opacityOf("#el-with-previous-target")).toBe("1");
  } finally {
    // The page (and its live SSE connections to /api/events and
    // /api/chat/stream, opened eagerly on mount — see App.tsx) must be
    // closed BEFORE cleanup()'s server.close(): Node's http.Server.close()
    // waits for every currently open connection to end, and an unclosed
    // page's SSE streams never end on their own. Diagnosed while chasing
    // an intermittent ~1-in-5 full-120s hang in this exact file (see this
    // ticket's report) — closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});
