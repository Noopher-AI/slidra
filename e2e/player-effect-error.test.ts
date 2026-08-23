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
 *   3. an unimplemented `family` value (`emphasis` — a real family this
 *      round's spec structurally supports but deliberately does not
 *      implement)
 *   4. an unimplemented `effect` value under an otherwise-valid family
 *      (`enter`/`wipe` — plausible if an author assumes PowerPoint-style
 *      transition names just work)
 *   5. an unimplemented `start` value (`with-previous` — plausible if an
 *      author wants two effects to land in the same step)
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
 * Every `page.close()` below matters, not just tidiness: diagnosed via
 * timestamped instrumentation across ~30 repeated runs that this file used
 * to hang for the full 120s test timeout roughly 1 time in 5-8, on
 * whichever `it()` happened to call `cleanup()` (→ `server.close()`) while
 * its own page's live-reload/chat SSE connections (opened eagerly on
 * mount — see App.tsx) were still open. `startServe`'s `close()` explicitly
 * closes streams it tracks itself but, like any plain `http.Server.close()`,
 * still waits on any other connection still open on the socket; an
 * unclosed Playwright page's connections only died once the *shared*
 * `browser` finally closed in `afterAll`, unblocking every hung
 * `server.close()` call at once — which is exactly what the instrumented
 * logs showed. Closing the page here, before `cleanup()`, removes that
 * wait entirely (16/16 clean repeats afterward). The underlying
 * `server.close()` fragility is a `packages/server` behavior this file
 * cannot fix (out of this ticket's file ownership) — reported to the
 * coordinator instead.
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

    await page.locator('button:has-text("播放")').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    await page.locator('button[aria-label="第 3 頁"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-3").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 3 頁：未實作的 family");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("emphasis");
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

    await page.locator('button:has-text("播放")').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    await page.locator('button[aria-label="第 4 頁"]').click();
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

    await page.locator('button:has-text("播放")').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    await page.locator('button[aria-label="第 5 頁"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-5").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("第 5 頁：未實作的 start");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("with-previous");
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
