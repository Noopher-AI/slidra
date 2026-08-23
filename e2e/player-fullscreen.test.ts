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

  await page.locator('button:has-text("播放")').click();
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

  await page.locator('button:has-text("播放")').click();
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

  await page.locator('button:has-text("播放")').click();
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

  await page.locator('button:has-text("播放")').click();
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

  await page.locator('button:has-text("播放")').click();
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
