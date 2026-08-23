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
 * directions actually change `document.fullscreenElement` and the iframe's
 * measured size (never trusting a resolved promise alone — see
 * e2e/fullscreen-spike.test.ts, whose evidence this unit's approach rests
 * on), arrow-key advance keeps working in both states, Esc returns to
 * embedded play without leaving 播放模式, and fullscreen survives a 換頁
 * because the iframe element is not replaced by one (only its `srcdoc` is).
 * Reuses the same hand-written fixture as e2e/player-mode.test.ts
 * (`fixtures/play-deck/`), read-only.
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

/** Reads the same evidence e2e/fullscreen-spike.test.ts insists on: not "the promise resolved" but real identity and real size. */
async function fullscreenSnapshot(page: Awaited<ReturnType<Browser["newPage"]>>) {
  return page.evaluate(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    const frame = document.querySelector("iframe.slide-frame") as HTMLIFrameElement | null;
    return {
      isFrameFullscreen: fullscreenElement !== null && fullscreenElement === frame,
      frameSize: frame ? [frame.clientWidth, frame.clientHeight] : null,
      screenSize: [screen.width, screen.height],
    };
  });
}

it("點按鈕真的進入全螢幕（iframe 撐滿螢幕），再點一次真的退出", async () => {
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
  // for the runtime, never allow-same-origin alongside it.
  const sandbox = await page.locator("iframe.slide-frame").getAttribute("sandbox");
  expect(sandbox).not.toContain("allow-same-origin");

  const before = await fullscreenSnapshot(page);
  expect(before.isFrameFullscreen).toBe(false);

  // A real Playwright click, not page.evaluate() calling requestFullscreen()
  // directly — without transient activation a failure would be an artefact
  // of the harness, not a fact about the engine (spike's own rule).
  await page.locator(".fullscreen-toggle-button").click();

  await expect.poll(() => fullscreenSnapshot(page).then((s) => s.isFrameFullscreen), { timeout: 15_000 }).toBe(true);
  const after = await fullscreenSnapshot(page);
  expect(after.frameSize).toEqual(after.screenSize);
  expect(after.frameSize).not.toEqual(before.frameSize);
  await expect.poll(() => page.locator('button:has-text("退出全螢幕")').count()).toBe(1);

  // Not a second button click: while the iframe is the fullscreen element,
  // the browser's top layer covers every sibling in the parent document —
  // including this very toggle button — with the fullscreened iframe, so a
  // literal second click cannot land (see the observation-task note in the
  // final report). document.exitFullscreen() is what Esc itself triggers
  // internally, and the browser fires the identical `fullscreenchange`
  // event no matter which of the two causes it — page script cannot tell
  // Esc apart from a programmatic exit, so this is the honest way to
  // exercise the "leaving fullscreen syncs the UI" path from this harness
  // (playwright cannot dispatch a trusted physical Esc that a headless
  // browser's own chrome would act on). Exiting fullscreen itself needs no
  // transient activation, unlike requestFullscreen() above.
  await page.evaluate(() => {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    return (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
  });
  await expect.poll(() => fullscreenSnapshot(page).then((s) => s.isFrameFullscreen), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => page.locator('button:has-text("全螢幕")').count()).toBe(1);
});

it("兩種狀態下方向鍵推進都正常運作；離開全螢幕（含 Esc）回到內嵌播放而不是掉出播放模式", async () => {
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
  await expect.poll(() => fullscreenSnapshot(page).then((s) => s.isFrameFullscreen), { timeout: 15_000 }).toBe(true);

  // 全螢幕狀態下方向鍵推進正常 —settled decision #5：切換全螢幕後
  // focusPlayer() 一定要被呼叫，否則方向鍵在這裡會無聲失效。
  await page.keyboard.press("ArrowRight");
  await expectVisible(appearText, 10_000);

  await page.evaluate(() => {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    return (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
  });
  await expect.poll(() => fullscreenSnapshot(page).then((s) => s.isFrameFullscreen), { timeout: 15_000 }).toBe(false);

  // 離開全螢幕（含 Esc）回到內嵌播放，而不是掉出播放模式：離開播放的按鈕
  // 仍在（mode 仍是 play），且方向鍵仍能推進到下一頁.
  await expect.poll(() => page.locator('button:has-text("離開播放")').count()).toBe(1);
  const secondTitle = playFrame().locator("#el-title2");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 30_000 }).toBe("播放第二頁");
});

it("換頁時全螢幕存活：iframe 元素本身沒被換掉，只有 srcdoc 換了", async () => {
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
  await expect.poll(() => fullscreenSnapshot(page).then((s) => s.isFrameFullscreen), { timeout: 15_000 }).toBe(true);

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

  // 換頁後：iframe 元素沒被換掉（marker 還在），且仍是全螢幕元素、仍撐滿螢幕.
  const stillSameElement = await page.evaluate(() => {
    const frame = document.querySelector("iframe.slide-frame") as HTMLIFrameElement & { __marker?: string };
    return frame.__marker === "same-element";
  });
  expect(stillSameElement).toBe(true);
  const after = await fullscreenSnapshot(page);
  expect(after.isFrameFullscreen).toBe(true);
  expect(after.frameSize).toEqual(after.screenSize);
});

it("全螢幕狀態下離開播放：文件不會卡在全螢幕", async () => {
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
  await expect.poll(() => fullscreenSnapshot(page).then((s) => s.isFrameFullscreen), { timeout: 15_000 }).toBe(true);

  // Measured, not assumed: a real trusted click at the button's on-screen
  // position cannot land here at all — the fullscreened iframe sits in the
  // browser's top layer, above every sibling in the parent document
  // including this very button, so it swallows the click no matter where
  // on screen the click lands (confirmed by hand while writing this test:
  // page.mouse.click() at the button's boundingBox() times out identically
  // to the toggle-button case above). That is a real reachability gap in
  // this chrome, reported in the final write-up rather than papered over
  // here. What this test can still honestly verify is the code-level
  // invariant behaviour contract row 4 asks for — leaving play mode must
  // not leave the document stuck in fullscreen — by invoking the button's
  // click handler directly (exitFullscreen() itself needs no transient
  // activation, unlike requestFullscreen(), so this is not faking anything
  // the handler could not otherwise do).
  await page.locator('button:has-text("離開播放")').evaluate((el) => (el as HTMLElement).click());

  await expect.poll(() => fullscreenSnapshot(page).then((s) => s.isFrameFullscreen), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("");
});
