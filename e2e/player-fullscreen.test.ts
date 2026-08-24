import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
 * 全螢幕開關 end to end (issue #29): the toggle only exists in 播放模式, both
 * directions actually change `document.fullscreenElement` and the real
 * measured size (never trusting a resolved promise alone — see
 * e2e/fullscreen-spike.test.ts, whose evidence this unit's approach rests
 * on), arrow-key advance keeps working in both states, Esc returns to
 * embedded play without leaving 播放模式, and fullscreen survives a 換頁
 * because the iframe element is not replaced by one (only its `srcdoc` is).
 * Reuses the same hand-written fixture as e2e/player-mode.test.ts
 * (`fixtures/play-deck/`), read-only.
 *
 * Second round (coordinator's revised settled decision #1, replacing the
 * first): the fullscreen target is `.canvas-area` — the container that
 * holds both the iframe and the play chrome `<nav>` — not the iframe
 * itself. The first round fullscreened the iframe directly and discovered,
 * by hand, that a real click can never land on anything in the parent
 * chrome once the iframe sits alone in the browser's fullscreen top layer
 * (`locator.click()` timed out with "intercepts pointer events" on both the
 * fullscreen-toggle button and the 離開播放 button). Fullscreening the
 * shared container fixes that: the chrome buttons are now descendants of
 * the fullscreen element, so they stay real, clickable DOM nodes. This
 * round's tests exercise both directions with genuine `locator.click()`
 * calls precisely to prove that gap is closed, not merely reasoned about.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/play-deck");
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

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-fullscreen-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-fullscreen-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;

  registry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "play-deck.comot");
  await packDirectory(deckFixtureDir, comotPath);
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

// Same rationale as player-mode.test.ts: play mode's hiding is CSS opacity,
// and Playwright's own isVisible() ignores opacity.
async function opacityOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).opacity);
}
async function expectVisible(locator: Locator, timeout = 30_000): Promise<void> {
  await expect.poll(() => opacityOf(locator).catch(() => "0"), { timeout }).not.toBe("0");
}
async function expectHidden(locator: Locator, timeout = 30_000): Promise<void> {
  await expect.poll(() => opacityOf(locator).catch(() => "0"), { timeout }).toBe("0");
}

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

it("全螢幕開關只在播放模式提供，檢視模式不存在這個控制項", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  // 檢視模式：控制項不存在（不是隱藏，是不在 DOM 裡）。
  expect(await page.locator(".fullscreen-toggle-button").count()).toBe(0);

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  await expect.poll(() => page.locator(".fullscreen-toggle-button").count()).toBe(1);
  // 是否全螢幕由作者選擇，播放開始不自動進入全螢幕：按鈕文字是「全螢幕」
  // （進入的動作），不是「退出全螢幕」.
  expect(await page.locator('button:has-text("全螢幕")').count()).toBe(1);
  expect(await page.locator('button:has-text("退出全螢幕")').count()).toBe(0);
});

/**
 * Reads the same kind of evidence e2e/fullscreen-spike.test.ts insists on —
 * not "the promise resolved" but real element identity and real measured
 * size — updated for the container-is-the-target design: the fullscreen
 * element must be `.canvas-area`, and the iframe must be its descendant
 * (proof the iframe did not somehow become the fullscreen element itself,
 * which was the first round's design and its unreachability problem).
 */
async function fullscreenSnapshot(page: Awaited<ReturnType<Browser["newPage"]>>) {
  return page.evaluate(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    const container = document.querySelector(".canvas-area");
    const frame = document.querySelector("iframe.slide-frame");
    return {
      isContainerFullscreen: fullscreenElement !== null && fullscreenElement === container,
      frameIsInsideFullscreenElement:
        fullscreenElement !== null && frame !== null && fullscreenElement.contains(frame),
      frameSize: frame ? [(frame as HTMLElement).clientWidth, (frame as HTMLElement).clientHeight] : null,
      screenSize: [screen.width, screen.height],
    };
  });
}

it("點按鈕真的進入全螢幕（容器撐滿螢幕、iframe 在容器內），再點一次真的退出", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");
  // Sandbox posture asserted, never just commented (ADR-0010): allow-scripts
  // for the runtime, never allow-same-origin alongside it. Unaffected by
  // this ticket switching its fullscreen target — canvas.ts (untouched)
  // still owns the iframe's sandbox attribute.
  const sandbox = await page.locator("iframe.slide-frame").getAttribute("sandbox");
  expect(sandbox).not.toContain("allow-same-origin");

  const before = await fullscreenSnapshot(page);
  expect(before.isContainerFullscreen).toBe(false);

  // A real Playwright click, not page.evaluate() calling requestFullscreen()
  // directly — without transient activation a failure would be an artefact
  // of the harness, not a fact about the engine (spike's own rule).
  await page.locator(".fullscreen-toggle-button").click();

  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);
  const after = await fullscreenSnapshot(page);
  // The iframe is a descendant of the fullscreen element, not the
  // fullscreen element itself — proof the container path is really in
  // effect and not a regression back to fullscreening the iframe.
  expect(after.frameIsInsideFullscreenElement).toBe(true);
  // Real size growth, not just a resolved promise: the iframe measurably
  // grew from its small embedded box (shrunk by the overview/chat sidebars
  // and the nav bar) all the way out to the screen's own dimensions — the
  // `.canvas-area:fullscreen` CSS rule sizes the container to 100vw/100vh
  // and the iframe (flex: 1 inside it, per the pre-existing .canvas rule)
  // fills essentially all of that, net of the nav bar's own height.
  expect(after.frameSize).not.toEqual(before.frameSize);
  expect(after.frameSize![0]).toBe(after.screenSize[0]);
  expect(after.frameSize![1]).toBeGreaterThan(after.screenSize[1] * 0.85);
  await expect.poll(() => page.locator('button:has-text("退出全螢幕")').count()).toBe(1);

  // The point of the coordinator's revised design: this second click must
  // be a genuine Playwright click landing on a real, on-screen button — no
  // evaluate()-driven .click() call, no mouse-position workaround. The
  // fullscreen-toggle button is now inside the fullscreen element
  // (.canvas-area), so it stays reachable.
  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => page.locator('button:has-text("全螢幕")').count()).toBe(1);
});

it("兩種狀態下方向鍵推進都正常運作；Esc 觸發的離開全螢幕回到內嵌播放而不是掉出播放模式", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  // 等播放模式真的接手畫面（兩個 enter 元素被 runtime 隱藏）再送出方向鍵，
  // 否則按鍵可能搶在新的播放 iframe 就緒之前發出.
  await expectHidden(fadeText);
  await expectHidden(appearText);
  // 進入播放時焦點交給播放器：不必先點一下就能推進.
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);
  await expectHidden(appearText);

  // 內嵌播放狀態下方向鍵推進正常.
  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // 全螢幕狀態下方向鍵推進正常 — settled decision #5：切換全螢幕後
  // focusPlayer() 一定要被呼叫，否則方向鍵在這裡會無聲失效。
  await page.keyboard.press("ArrowRight");
  await expectVisible(appearText, 10_000);

  // Esc's own effect is document.exitFullscreen() firing internally, and
  // the browser dispatches the identical fullscreenchange event whichever
  // of the two causes it — page script cannot tell them apart, so this is
  // the honest way to exercise "leaving fullscreen syncs the UI" from a
  // harness that cannot dispatch a trusted physical Esc a headless
  // browser's own chrome would act on (confirmed while writing round one:
  // page.keyboard.press("Escape") alone never changed fullscreenElement
  // here). Exiting fullscreen needs no transient activation, unlike
  // requestFullscreen().
  await page.evaluate(() => {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    return (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
  });
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);

  // 離開全螢幕（含 Esc）回到內嵌播放，而不是掉出播放模式：離開播放的按鈕
  // 仍在（mode 仍是 play），且方向鍵仍能推進到下一頁.
  await expect.poll(() => page.locator('button:has-text("離開播放")').count()).toBe(1);
  const secondTitle = playFrame().locator("#el-title2");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 30_000 }).toBe("播放第二頁");
});

it("換頁時全螢幕存活：iframe 元素本身沒被換掉，只有 srcdoc 換了，容器仍是全螢幕元素", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expectHidden(fadeText);
  await expectHidden(appearText);

  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // A stable per-element identity that survives a srcdoc swap but would not
  // survive the iframe element itself being destroyed and rebuilt: assign a
  // marker property on the live iframe node.
  await page.evaluate(() => {
    const frame = document.querySelector("iframe.slide-frame") as HTMLIFrameElement & { __marker?: string };
    frame.__marker = "same-element";
  });

  // 推進兩步換到第二頁 (fade -> appear -> advance-past-end).
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);
  await page.keyboard.press("ArrowRight");
  await expectVisible(appearText, 10_000);
  const secondTitle = playFrame().locator("#el-title2");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 30_000 }).toBe("播放第二頁");

  // 換頁後：iframe 元素沒被換掉（marker 還在），容器仍是全螢幕元素，
  // iframe 仍在容器內、仍撐滿.
  const stillSameElement = await page.evaluate(() => {
    const frame = document.querySelector("iframe.slide-frame") as HTMLIFrameElement & { __marker?: string };
    return frame.__marker === "same-element";
  });
  expect(stillSameElement).toBe(true);
  const after = await fullscreenSnapshot(page);
  expect(after.isContainerFullscreen).toBe(true);
  expect(after.frameIsInsideFullscreenElement).toBe(true);

  // 換頁後方向鍵仍正常，即使已經在第二頁的全螢幕狀態下.
  const secondFade = playFrame().locator("#el-second-fade");
  await expectHidden(secondFade);
  await page.keyboard.press("ArrowRight");
  await expectVisible(secondFade, 10_000);
});

it("全螢幕狀態下離開播放：真的點按鈕就能退出，文件不會卡在全螢幕", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const fadeText = page.frameLocator("iframe.slide-frame").locator("#el-fade-in");

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expectHidden(fadeText);

  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // Genuine click on a real, reachable button — the point of moving the
  // fullscreen target to the shared container: 離開播放 is a descendant of
  // it, so a real Playwright click lands on it even while fullscreen (round
  // one had to fall back to el.click() here because a real click timed out;
  // see the report for that measurement).
  await page.locator('button:has-text("離開播放")').click();

  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("");
});

it("播放錯誤與全螢幕錯誤同時成立時，兩則通知並列可見、不互相覆蓋（review gate round 1, P2）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  // canvas.ts (not owned by this ticket) cannot be edited to fabricate a
  // 播放錯誤 (canvasState.error) on demand, so this test proves the P2 fix
  // — "notices must stack, not overlap" — with the two notices this
  // ticket's own code genuinely produces together: the player-focus-notice
  // (焦點被搶走) and a real 全螢幕錯誤 notice (a genuinely rejected
  // requestFullscreen() call, not a fabricated success). That is the same
  // shared-wrapper CSS/DOM layout bug the reviewer flagged; it does not
  // depend on which two player-notices children happen to be present.
  const focusNotice = page.locator(".player-focus-notice");
  // Entering play mode hands focus to the player asynchronously (the
  // runtime posts "ready" once its own listeners are attached); racing
  // that with "steal focus" below before it has settled made this flicker
  // during development (same race player-mode.test.ts already documents),
  // so wait for the initial auto-focus to land first.
  await expect.poll(() => focusNotice.count(), { timeout: 10_000 }).toBe(0);
  await page.locator('button:has-text("離開播放")').focus();
  await expect.poll(() => focusNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

  // 用一個一定會拒絕的 requestFullscreen 替身製造真實的全螢幕錯誤
  // 通知：這是 toggleFullscreen() 的 catch 分支真的會走到的路徑（引擎
  // 拒絕請求），不是假造成功又謊報失敗。
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      __originalRequestFullscreen?: () => Promise<void>;
    };
    container.__originalRequestFullscreen = container.requestFullscreen.bind(container);
    container.requestFullscreen = () => Promise.reject(new Error("模擬測試：全螢幕請求被拒絕"));
  });
  // 「焦點通知與全螢幕錯誤通知同時存在」依設計只維持約 100 毫秒：全螢幕
  // 失敗的路徑會呼叫 focusPlayer()（App.tsx 的 settled decision #5），焦點
  // 一回到播放器，焦點通知就卸載、錯誤通知往上遞補。跨過那個邊界做兩次
  // 獨立的 boundingBox() round-trip，會拿到「卸載前的焦點框」配「遞補後的
  // 錯誤框」——兩個從未同時存在的矩形，算出來必然相交。issue #43 追到的
  // 間歇失敗就是這麼來的，與機器負載無關（負載只決定那兩次讀取會不會被
  // 切開）。所以改成在頁面內逐幀取樣：每一幀在同一個 layout pass 裡取兩個
  // 矩形，沒有任何 round-trip 可以插進中間。取樣要在點擊之前裝好，才涵蓋
  // 得到整個窗口。
  await page.evaluate(() => {
    const w = window as unknown as { __noticeOverlaps: boolean[] };
    w.__noticeOverlaps = [];
    const sample = () => {
      const focus = document.querySelector(".player-focus-notice");
      const error = Array.from(document.querySelectorAll(".player-error-notice")).find((el) =>
        el.textContent?.includes("全螢幕切換失敗"),
      );
      if (focus && error) {
        const a = focus.getBoundingClientRect();
        const b = error.getBoundingClientRect();
        // 兩者都有實際大小才算數，這同時取代了舊的 isVisible() 檢查.
        if (a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0) {
          w.__noticeOverlaps.push(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
        }
      } else if (w.__noticeOverlaps.length > 0) {
        return; // 窗口已經關上，停止取樣，別留一個 rAF 迴圈空轉
      }
      requestAnimationFrame(sample);
    };
    sample();
  });
  await page.locator(".fullscreen-toggle-button").click();
  const fullscreenErrorNotice = page.locator(".player-error-notice", { hasText: "全螢幕切換失敗" });
  await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBe(1);

  // 取樣必須真的抓到「兩則同時可見」的幀，否則下面那條斷言是空的——與其
  // 靜默地什麼都沒驗到，不如讓它明確地失敗.
  const overlapCount = () =>
    page.evaluate(() => (window as unknown as { __noticeOverlaps: boolean[] }).__noticeOverlaps.length);
  await expect.poll(overlapCount, { timeout: 10_000 }).toBeGreaterThan(0);

  // 不只是「都在畫面上」，而是彼此的矩形沒有重疊——這才是 P2 real bug 的
  // 反面證據：先前兩者用同一組 position:absolute 疊在同一個位置，後渲染的
  // 會蓋住先渲染的，isVisible() 仍然會回報 true（Playwright 的可見性判斷不
  // 看 z-order 疊加），所以要量真實座標矩形是否相交。共存期間的每一幀都
  // 不許相交，一幀都不行.
  const overlapFrames = await page.evaluate(
    () => (window as unknown as { __noticeOverlaps: boolean[] }).__noticeOverlaps,
  );
  expect(overlapFrames.some((overlapped) => overlapped)).toBe(false);
});

it("成功地從外部離開全螢幕後，舊的全螢幕失敗訊息會被清掉（review gate round 1, P2）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  // 進到真正的全螢幕狀態，這樣「退出」才有真實意義（不是憑空捏造 isFullscreen）。
  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // 逼出 exitFullscreen() 失敗這個前置狀態，在真實引擎裡很難用純手勢
  // 逼出來而不造假（headless Chromium 沒有任何合法操作序列會讓
  // document.exitFullscreen() 在「文件確實是全螢幕」時拒絕——這是規格保證
  // 會成功的情況）。這裡改用一個誠實的替代做法：monkey-patch
  // document.exitFullscreen 讓它回傳一次性的 rejected promise，藉此讓
  // toggleFullscreen() 的 catch 分支真的執行到（那段程式碼本身是真的，
  // 被替換的只是瀏覽器 API 的回傳值，模擬「引擎拒絕退出」這個規格上允許
  // 但這個測試環境裡逼不出來的情況）。真實的瀏覽器全螢幕狀態這時候完全
  // 沒被動到——因為呼叫從未真的傳到底層，文件仍然貨真價實地是全螢幕。
  await page.evaluate(() => {
    const doc = document as Document & {
      __originalExitFullscreen?: () => Promise<void>;
      webkitExitFullscreen?: () => Promise<void>;
    };
    doc.__originalExitFullscreen = (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.bind(doc);
    doc.exitFullscreen = () => Promise.reject(new Error("模擬測試：退出全螢幕被拒絕"));
  });

  // 真實點擊「退出全螢幕」按鈕，因為此時 isFullscreen 為 true，這顆按鈕的
  // onClick 真的會呼叫（被替換過的）exitFullscreen()，走到 catch 分支。
  // 「焦點通知與全螢幕錯誤通知同時存在」依設計只維持約 100 毫秒：全螢幕
  // 失敗的路徑會呼叫 focusPlayer()（App.tsx 的 settled decision #5），焦點
  // 一回到播放器，焦點通知就卸載、錯誤通知往上遞補。跨過那個邊界做兩次
  // 獨立的 boundingBox() round-trip，會拿到「卸載前的焦點框」配「遞補後的
  // 錯誤框」——兩個從未同時存在的矩形，算出來必然相交。issue #43 追到的
  // 間歇失敗就是這麼來的，與機器負載無關（負載只決定那兩次讀取會不會被
  // 切開）。所以改成在頁面內逐幀取樣：每一幀在同一個 layout pass 裡取兩個
  // 矩形，沒有任何 round-trip 可以插進中間。取樣要在點擊之前裝好，才涵蓋
  // 得到整個窗口。
  await page.evaluate(() => {
    const w = window as unknown as { __noticeOverlaps: boolean[] };
    w.__noticeOverlaps = [];
    const sample = () => {
      const focus = document.querySelector(".player-focus-notice");
      const error = Array.from(document.querySelectorAll(".player-error-notice")).find((el) =>
        el.textContent?.includes("全螢幕切換失敗"),
      );
      if (focus && error) {
        const a = focus.getBoundingClientRect();
        const b = error.getBoundingClientRect();
        // 兩者都有實際大小才算數，這同時取代了舊的 isVisible() 檢查.
        if (a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0) {
          w.__noticeOverlaps.push(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
        }
      } else if (w.__noticeOverlaps.length > 0) {
        return; // 窗口已經關上，停止取樣，別留一個 rAF 迴圈空轉
      }
      requestAnimationFrame(sample);
    };
    sample();
  });
  await page.locator(".fullscreen-toggle-button").click();
  const fullscreenErrorNotice = page.locator(".player-error-notice", { hasText: "全螢幕切換失敗" });
  await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBe(1);
  // 錯誤發生時不能假造成功：畫面必須仍然回報全螢幕（真實瀏覽器狀態也
  // 確實還是全螢幕——上面那次呼叫從未真的觸及底層 API）。
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 5_000 })
    .toBe(true);

  // 還原成真正的 exitFullscreen，然後用它觸發一次「真實、會成功」的離開
  // 全螢幕——等同於本檔案其他測試裡代表 Esc 的既有手法。這次呼叫真的會
  // 讓瀏覽器離開全螢幕，也真的會發出 fullscreenchange 事件。
  await page.evaluate(() => {
    const doc = document as Document & { __originalExitFullscreen?: () => Promise<void> };
    if (doc.__originalExitFullscreen) doc.exitFullscreen = doc.__originalExitFullscreen;
    return doc.exitFullscreen();
  });

  // 修好之前：fullscreenchange 處理器只更新 isFullscreen，舊的失敗訊息會
  // 留在畫面上。修好之後：這次真實、成功的 fullscreenchange 必須把它清掉。
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBe(0);
});

it("離開播放時若 requestFullscreen() 仍在 pending，文件最終不會卡在全螢幕（review gate round 2, P2）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  // Delays the real underlying requestFullscreen() call itself, not just
  // the promise wrapping it — it really does enter fullscreen, only later
  // (coordinator's own phrasing: 真的會進全螢幕，只是晚一點). Only
  // artificially delaying the returned promise while letting the real call
  // fire immediately would not reproduce this race at all: the real
  // fullscreenchange event (and this app's isFullscreen state) would still
  // land right away, regardless of how long our own promise is stalled.
  // The setTimeout here defers the actual native call itself by 300ms; it
  // still runs soon enough to be within the click's transient activation
  // window, so it remains a real, successful fullscreen request — just a
  // late one, exactly the in-flight window review gate round 2's P2
  // describes.
  //
  // A handle to the delayed call's own settlement is stashed on the
  // container (`__delayedFullscreenSettled`) — review gate round 5 found
  // that the first version of this test polled for "not fullscreen"
  // starting immediately after the two clicks. At that instant the delayed
  // native call has not fired yet, so `fullscreenElement` is still null
  // for the same reason it would be null before any bug existed —
  // `expect.poll(...).toBe(false)` accepts the very first sample and
  // returns instantly, never actually observing the moment (t≈300ms) the
  // race is about. That made the test pass unconditionally, with or
  // without the fix. Waiting on this handle first guarantees the check
  // below only starts once the real transition has already happened.
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      __originalRequestFullscreen?: () => Promise<void>;
      __delayedFullscreenSettled?: Promise<unknown>;
    };
    const original = container.requestFullscreen.bind(container);
    container.__originalRequestFullscreen = original;
    container.requestFullscreen = () => {
      const delayed = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          original().then(resolve, reject);
        }, 300);
      });
      // .catch() so a rejection here cannot make the awaited handle below
      // reject and abort the test — only the timing matters to this test,
      // not whether the delayed request itself succeeds.
      container.__delayedFullscreenSettled = delayed.catch(() => {});
      return delayed;
    };
  });

  // A real click starts the (now delayed) fullscreen request.
  await page.locator(".fullscreen-toggle-button").click();

  // Within the 300ms window before the real native call has even fired —
  // isFullscreen (React state) is still false here, exactly the moment the
  // reviewer's finding describes — a real click on 離開播放.
  await page.locator('button:has-text("離開播放")').click();

  // Wait until the delayed native requestFullscreen() call has actually
  // landed (t ≥ 300ms) before checking anything at all. This is the fix
  // for round 5's finding: only after this await do we know the race's
  // critical moment has genuinely passed, so a poll started from here on
  // is measuring the real aftermath, not a pre-race snapshot.
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      __delayedFullscreenSettled?: Promise<unknown>;
    };
    return container.__delayedFullscreenSettled;
  });

  function readFullscreen(): Promise<boolean> {
    return page.evaluate(() => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
    });
  }

  // Before the fix: handleExitPlay() trusted the still-false isFullscreen
  // state at click time, skipped exiting fullscreen, and returned to view
  // mode; the delayed request then landed for real (confirmed above), and
  // nothing in the buggy code path ever exits it again — the document
  // stays genuinely stuck fullscreen forever, with no play chrome left to
  // click out of it. After the fix: handleExitPlay() itself awaits the
  // same in-flight request, then asks the browser's own fullscreenElement
  // and exits it if still fullscreen — so this app's own async cleanup
  // (a further, fast exitFullscreen() call) may still be finishing exactly
  // as this test's independent await above resolves, which is why this is
  // still a poll rather than one immediate read.
  await expect.poll(() => readFullscreen(), { timeout: 5_000 }).toBe(false);

  // Stability, not just "eventually false once" (round 5's ask): sample a
  // few more times over a short window to make sure it does not flip back
  // to fullscreen. A genuinely fixed run never does; this only guards
  // against asserting on a value that happens to be false for one instant
  // mid-transition.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(100);
    expect(await readFullscreen()).toBe(false);
  }

  // 離開播放本身也必須真的完成，不是卡住半途：畫面回到檢視模式的「播放」按鈕.
  await expect.poll(() => page.locator('.view-btn[data-view="play"]').count()).toBe(1);
});

it("兩個全螢幕 API 都不存在時，點下開關仍會把焦點交回播放器（review gate round 2, P2）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  const focusNotice = page.locator(".player-focus-notice");
  // 等初次自動 focus 先穩定下來（理由同前面幾個測試），再自己偷走焦點.
  await expect.poll(() => focusNotice.count(), { timeout: 10_000 }).toBe(0);
  await page.locator('button:has-text("離開播放")').focus();
  await expect.poll(() => focusNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

  // 一次性量測：把兩個全螢幕 API 都從容器上拿掉，證明「不支援全螢幕」這條
  // early-return 路徑真的走得到，而不是永遠不會發生的死路——這是
  // toggleFullscreen() 裡 `if (!request) { ...; return; }` 那個分支唯一
  // 會被進入的方式.
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      requestFullscreen?: unknown;
      webkitRequestFullscreen?: unknown;
    };
    Object.defineProperty(container, "requestFullscreen", { value: undefined, configurable: true });
    Object.defineProperty(container, "webkitRequestFullscreen", { value: undefined, configurable: true });
  });

  await page.locator(".fullscreen-toggle-button").click();

  // 這條路徑走到了：全螢幕錯誤通知顯示「這個瀏覽器不支援全螢幕」.
  const unsupportedNotice = page.locator(".player-error-notice", { hasText: "這個瀏覽器不支援全螢幕" });
  await expect.poll(() => unsupportedNotice.count(), { timeout: 10_000 }).toBe(1);

  // 修好之前：這個 early return 從不呼叫 focusPlayer()，焦點停在按鈕上，
  // 焦點提示會一直留著。修好之後：即使全螢幕不支援，焦點還是要交回播放器.
  await expect.poll(() => focusNotice.count(), { timeout: 10_000 }).toBe(0);
});

it("先發後至：較早的請求先 settle 時不會清掉還在飛行中的較晚請求（review gate round 3, P2）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  // 兩次呼叫各給不同的延遲：第一次 100ms 先落地，第二次 600ms 後落地——
  // 造出「較早的請求先 settle，較晚的還在飛行中」這個順序。每次呼叫都留
  // 一個可等待的 handle（settled[0]/settled[1]），測試才能不靠猜時間點就
  // 精確等到「第一個已經落地、第二個還沒」的那個窗口。
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      __settled?: Array<Promise<unknown>>;
    };
    const original = container.requestFullscreen.bind(container);
    const delays = [100, 600];
    let callCount = 0;
    const settled: Array<Promise<unknown>> = [];
    container.__settled = settled;
    container.requestFullscreen = () => {
      const index = callCount++;
      const delayed = new Promise<void>((resolve, reject) => {
        setTimeout(
          () => {
            original().then(resolve, reject);
          },
          delays[index] ?? 600,
        );
      });
      settled[index] = delayed.catch(() => {});
      return delayed;
    };
  });

  // 兩次真實點擊，都在 isFullscreen 還是 false 的窗口內（真實瀏覽器狀態要
  // 到延遲呼叫落地才會變），所以兩次都會進 toggleFullscreen() 的「進入」
  // 分支，各自捕捉自己的 promise 存進 fullscreenRequestRef.
  await page.locator(".fullscreen-toggle-button").click();
  await page.locator(".fullscreen-toggle-button").click();

  // 等第一個（較早的）請求真的落地（t≈100ms）——這正是舊版無條件清除
  // 會把 fullscreenRequestRef 錯誤地清成 null 的那個時刻，即使第二個
  // 請求（t≈600ms 才會落地）根本還沒完成.
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      __settled?: Array<Promise<unknown>>;
    };
    return container.__settled?.[0];
  });

  // 修好之前：第一個請求的 finally 無條件把 fullscreenRequestRef 清成
  // null，這裡點「離開播放」時 handleExitPlay() 找不到任何 pending 的
  // 請求可等，會立刻用（尚未反映第二個請求的）當下真實 fullscreenElement
  // 判斷，這時多半還不是全螢幕，於是直接離開播放、不退出全螢幕；等第二個
  // 請求在 t≈600ms 真的落地，文件會卡在全螢幕，而且已經沒有播放 chrome
  // 可以點出去。修好之後：第一個請求 settle 時不會動到已經指向第二個
  // 請求的 ref，離開播放時仍然找得到（第二個）pending 的請求可以等.
  await page.locator('button:has-text("離開播放")').click();

  // 等第二個（較晚的）請求也真的落地，才開始檢查最終狀態——同樣是 round 5
  // 修掉的那個原則：不能在轉場真正發生之前就取樣.
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      __settled?: Array<Promise<unknown>>;
    };
    return container.__settled?.[1];
  });

  function readFullscreen(): Promise<boolean> {
    return page.evaluate(() => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
    });
  }

  await expect.poll(() => readFullscreen(), { timeout: 5_000 }).toBe(false);
  // 穩定狀態，不是抓到單一時間點恰好是 false 的樣本.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(100);
    expect(await readFullscreen()).toBe(false);
  }

  await expect.poll(() => page.locator('.view-btn[data-view="play"]').count()).toBe(1);
});

it("即時重載把最後一張投影片移除時，離開播放與全螢幕開關仍然看得到、點得到（review gate round 4, P2）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('.view-btn[data-view="play"]').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // 真實的外部編輯：直接改寫這個 presentation 在磁碟上真正的工作目錄
  // （`open` 指令解壓縮出來的那份，`packages/core/src/workspace.ts` 的
  // `workDirFor()` 命名慣例——不是 e2e/fixtures/play-deck 那份唯讀共用
  // fixture），把 slides 清空，這樣才會真的走過 server 的檔案監看 → SSE
  // presentation-changed → canvas.ts 的 reload() 這整條即時重載路徑，
  // 不是模擬出來的.
  const workDir = path.join(coMotionHome, "work", presentationId);
  const projectJsonPath = path.join(workDir, "project.json");
  const original = await readFile(projectJsonPath, "utf-8");
  const emptied = JSON.parse(original) as { slides: string[] };
  emptied.slides = [];
  await writeFile(projectJsonPath, JSON.stringify(emptied, null, 2), "utf-8");

  // 等重載真的落地，不是猜一個時間就開始斷言（round 5 的教訓）：
  // canvas.ts 的 renderPlay() 在 currentIndex === -1（slides 真的變空）
  // 時會畫出這段固定文字，是可觀察、非猜測的落地訊號.
  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("body").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toContain("此簡報沒有投影片");

  // 修好之前：hasSlides 變 false，整條 <nav> 消失，離開播放與全螢幕開關
  // 都不在畫面上了，而且沒有人主動退出全螢幕——作者被留在一個沒有 App
  // 內建出口的全螢幕空白畫面，只剩瀏覽器自己的 Esc。修好之後：這兩顆
  // 按鈕仍然在.
  await expect.poll(() => page.locator('button:has-text("離開播放")').count()).toBe(1);
  await expect.poll(() => page.locator(".fullscreen-toggle-button").count()).toBe(1);

  // 全螢幕本身沒有被靜默、未經作者同意地強制退出——是否離開全螢幕仍然由
  // 作者決定 (settled decision #6)，投影片數量不替他做這個決定.
  expect((await fullscreenSnapshot(page)).isContainerFullscreen).toBe(true);

  // 真實點擊離開播放，證明它不只是存在於 DOM 裡，是真的能點的——同時也
  // 走一次 handleExitPlay() 的既有邏輯，確認全螢幕會一併退出.
  await page.locator('button:has-text("離開播放")').click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => page.locator('button:has-text("離開播放")').count()).toBe(0);
});
