import { access, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Locator } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * 播放模式 end to end (issue #28): entering play, stepping through effects
 * with the keyboard, advancing past a slide's last step, leaving play, and
 * the two static-safety guarantees the spec requires (story 20: a slide
 * opened directly in a browser shows every element; the underlying file's
 * bytes never change across a play session). The hand-written fixture is
 * `fixtures/play-deck/` — real effect lists, real steps, nothing generated.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/comotion");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
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

  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);

  coMotionHome = await mkdtemp(path.join(tmpdir(), "comotion-e2e-playmode-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "comotion-e2e-playmode-files-"));
  process.env.COMOTION_HOME = coMotionHome;
  // [E4.T9]/F7: comotion serve now spawns the Rust binary for every read/write.
  process.env.COMOTION_BIN = coMotionBin;

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

// This suite runs under plain vitest, not @playwright/test, so
// `expect(locator).toBeVisible()` is not available. It would not have
// been the right check anyway: play mode's hiding is driven by CSS
// `opacity`, and Playwright's own `isVisible()` deliberately ignores
// opacity (an opacity:0 element still has a bounding box and no
// `display:none`, so it reads as "visible"). What actually distinguishes
// hidden-by-the-runtime from shown here is the computed opacity itself.
async function opacityOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).opacity);
}
async function expectVisible(locator: Locator, timeout = 30_000): Promise<void> {
  // Not strictly "1": a fade in progress can be polled mid-transition.
  // What must never be true is still-hidden ("0").
  await expect.poll(() => opacityOf(locator).catch(() => "0"), { timeout }).not.toBe("0");
}
async function expectHidden(locator: Locator, timeout = 30_000): Promise<void> {
  await expect.poll(() => opacityOf(locator).catch(() => "0"), { timeout }).toBe("0");
}

async function readSlideText(id: string, virtualPath: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: virtualPath });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

it("完整播放路徑：進入播放、逐步推進、換頁、離開播放，投影片檔案位元組完全未變", async () => {
  const before001 = await readSlideText(presentationId, "slides/001.svg");
  const before002 = await readSlideText(presentationId, "slides/002.svg");

  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");
  const bgText = playFrame().locator("#el-title");

  await expect.poll(() => bgText.textContent().catch(() => null), { timeout: 30_000 }).toBe("播放第一頁");

  // 沒有屬於任何步驟的元素，在進入該頁時就已經在畫面上.
  await expectVisible(bgText);

  // 進入播放前：兩個 enter 元素還沒被 runtime 隱藏（那是播放專屬的事）；
  // view 模式的投影片就是它的靜態最終長相 (ADR-0009)。
  await expectVisible(fadeText);

  await page.locator('.play-button').click();

  // 播放模式的 iframe 有 allow-scripts，沒有 allow-same-origin.
  const sandbox = await page.locator("iframe.slide-frame").getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");

  // 進入播放時不會閃過完整內容：一進來，兩個 enter 元素應立刻不可見。
  await expectHidden(fadeText);
  await expectHidden(appearText);
  // 不屬於任何步驟的元素，進入播放時仍然在畫面上。
  await expectVisible(bgText);

  // 進入播放時焦點交給播放器：方向鍵立刻能推進，不必先點一下。
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);
  await expectHidden(appearText);

  await page.keyboard.press("ArrowRight");
  await expectVisible(appearText, 10_000);

  // 推進到最後一步再按，換到下一頁。
  await page.keyboard.press("ArrowRight");
  const secondTitle = playFrame().locator("#el-title2");
  await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 30_000 }).toBe("播放第二頁");
  const secondFade = playFrame().locator("#el-second-fade");
  await expectHidden(secondFade);

  await page.keyboard.press("ArrowRight");
  await expectVisible(secondFade, 10_000);

  // 已在整份簡報的最後一步：再按一次不動、不當機。
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondTitle.textContent().catch(() => null)).toBe("播放第二頁");

  // 目前在第二頁唯一的一步（el-second-fade），已經沒有更早的步驟可退：
  // ArrowLeft 觸發 retreat-past-start，換回第一頁，且第一頁以「整頁跑完」
  // 的姿態呈現——兩個步驟（fade、appear）都已經套用，不是回到它的開頭。
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => bgText.textContent().catch(() => null), { timeout: 30_000 }).toBe("播放第一頁");
  await expectVisible(fadeText);
  await expectVisible(appearText);

  // 離開播放模式，回到檢視。
  await page.locator('button:has-text("離開播放")').click();
  // ADR-0011: view mode now runs a script too (selection-runtime.js), so
  // the sandbox no longer goes back to "" here. What this line pins is
  // that it carries only allow-scripts — never allow-same-origin.
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("allow-scripts");

  expect(pageErrors).toEqual([]);

  const after001 = await readSlideText(presentationId, "slides/001.svg");
  const after002 = await readSlideText(presentationId, "slides/002.svg");
  expect(sha256(after001)).toBe(sha256(before001));
  expect(sha256(after002)).toBe(sha256(before002));
  expect(after001).toBe(before001);
  expect(after002).toBe(before002);
});

it("焦點被搶到播放器外時，方向鍵照樣推進，不必先去把焦點修好（#68）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect.poll(() => fadeText.textContent().catch(() => null), { timeout: 30_000 }).toBe("淡入文字");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expectHidden(fadeText);

  // Entering play hands focus to the player asynchronously (the runtime
  // posts "ready" once its listeners are attached, and only then does
  // canvas.ts call focusPlayer()). Settle that first, or "steal focus"
  // below races it and the delayed auto-focus undoes the theft.
  const playBar = page.locator(".play-bar");
  await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("true");

  // Move focus out of the player the way a real author gets there: one
  // press of Tab. Every mouse path back out of the iframe already hands
  // focus back on its own (measured on #68), so Tab is not a stand-in for
  // some other trigger — it *is* the trigger, and it is a keyboard one,
  // which is what made the old "click this notice" answer unusable.
  await page.keyboard.press("Tab");
  await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("false");

  // The point of #68: the key press still lands. The parent document sees
  // this keydown (the runtime never does — focus is not in the iframe) and
  // forwards it, so the step advances anyway.
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);

  // …and the forward hands focus back, so the next key press goes the
  // runtime's own way rather than needing the parent again.
  await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("true");
  await page.keyboard.press("ArrowRight");
  await expectVisible(appearText, 10_000);
});

it("播放器握著焦點時，一次方向鍵只推進一步——父文件不會跟 runtime 搶著反應（#68）", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect.poll(() => fadeText.textContent().catch(() => null), { timeout: 30_000 }).toBe("淡入文字");

  await page.locator('.play-button').click();
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
  await expectHidden(fadeText);
  await expectHidden(appearText);

  // One press with focus inside the player: the first step runs and the
  // second must NOT. If the parent-side handler failed to stand down while
  // the runtime holds focus, both would react and this single press would
  // eat two steps.
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);
  await expectHidden(appearText);
});

// [E2.T11] §2 邊界 8: transition 一律用 `slide transition set` 在測試裡設，
// 不動 fixtures/play-deck/ 本身；順便證明 CLI 路徑跟播放時真的一致。
it("[A10]/[A11] 離開頁先播 exit 才真的換頁（前進）；退頁瞬切，不播 exit", async () => {
  await registry.dispatch("slide transition set", {
    id: presentationId,
    slidePath: "slides/001.svg",
    exit: "fade",
    exitDuration: 0.3,
  });
  try {
    const page = await browser.newPage();
    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const fadeText = playFrame().locator("#el-fade-in");
    const appearText = playFrame().locator("#el-appear-in");
    const secondTitle = playFrame().locator("#el-title2");
    const frame = page.locator("iframe.slide-frame");

    await page.goto(server.url);
    await page.locator(".play-button").click();
    await expect
      .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
      .toBe("true");

    // 推進完第一頁的兩個步驟。
    await page.keyboard.press("ArrowRight");
    await expectVisible(fadeText, 10_000);
    await page.keyboard.press("ArrowRight");
    await expectVisible(appearText, 10_000);

    // 第三次按 → 觸發前進換頁：離開頁（第一頁）先播 exit。
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => frame.evaluate((el) => (el as HTMLElement).style.opacity), { timeout: 5_000 }).toBe("0");
    // exit 還沒播完，仍然是第一頁的內容。
    expect(await playFrame().locator("#el-title").count()).toBeGreaterThan(0);

    // exit 播完才真的換到第二頁。
    await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 10_000 }).toBe("播放第二頁");
    await expect.poll(() => frame.evaluate((el) => (el as HTMLElement).style.opacity), { timeout: 5_000 }).not.toBe("0");

    // 倒退回第一頁：retreatPastStart() 從不呼叫 playExitTransition()——不像
    // 前進換頁，這裡沒有非同步的中途窗口需要輪詢，按下當下就能斷言。
    await page.keyboard.press("ArrowLeft");
    expect(await frame.evaluate((el) => (el as HTMLElement).style.opacity)).not.toBe("0");
    await expect
      .poll(() => playFrame().locator("#el-title").textContent().catch(() => null), { timeout: 10_000 })
      .toBe("播放第一頁");
  } finally {
    await registry.dispatch("slide transition set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      exit: "none",
      exitDuration: 0.5,
    });
  }
});

it("[A12] Space／PageDown／點畫面三者都能推進一個效果步驟；PageUp 能退回", async () => {
  async function freshPlayPage() {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.locator(".play-button").click();
    await expect
      .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
      .toBe("true");
    return page;
  }

  for (const key of ["Space", "PageDown"] as const) {
    const page = await freshPlayPage();
    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const fadeText = playFrame().locator("#el-fade-in");
    const appearText = playFrame().locator("#el-appear-in");
    await page.keyboard.press(key);
    await expectVisible(fadeText, 10_000);
    await expectHidden(appearText);
    await page.close();
  }

  {
    const page = await freshPlayPage();
    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const fadeText = playFrame().locator("#el-fade-in");
    const appearText = playFrame().locator("#el-appear-in");
    const box = await page.locator(".play-mousemove-catcher").boundingBox();
    if (!box) throw new Error("找不到 .play-mousemove-catcher 的 bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expectVisible(fadeText, 10_000);
    await expectHidden(appearText);
    await page.close();
  }

  {
    // PageUp 退回一步——跟既有的 ArrowLeft 測項同一套前提：必須先站在第 2
    // 步（currentStep >= 1），退回一步才會真的改動畫面，不是送
    // retreat-past-start（那是「已經在第一步」時的既有行為，跟 PageUp 本身
    // 無關，見 player-runtime.test.ts 的對照測項）。
    const page = await freshPlayPage();
    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const fadeText = playFrame().locator("#el-fade-in");
    const appearText = playFrame().locator("#el-appear-in");
    await page.keyboard.press("ArrowRight");
    await expectVisible(fadeText, 10_000);
    await page.keyboard.press("ArrowRight");
    await expectVisible(appearText, 10_000);

    await page.keyboard.press("PageUp");
    await expectHidden(appearText);
    expect(await fadeText.evaluate((el) => getComputedStyle(el).opacity)).not.toBe("0");
    await page.close();
  }
});

it("[A13] 播放模式按 Esc（焦點在播放器內）回到編輯模式：.titlebar 重新出現，iframe sandbox 回到 allow-scripts", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.locator(".play-button").click();
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  // 焦點在播放 iframe 內——這個 Esc 由 player-runtime.js 自己的 keydown 接住，
  // post 一則 "exit-play" 給父文件，跟父文件自己的 Escape 監聽器（焦點在外
  // 時那條）走的是不同路徑，兩者都該導到同一個結果。
  await page.keyboard.press("Escape");

  await expect.poll(() => page.locator(".titlebar").count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("allow-scripts");
});

it("story 20：單張投影片檔案直接用瀏覽器打開，所有元素（含只在播放時才出現的）都看得到", async () => {
  const page = await browser.newPage();
  await page.goto(`${server.url}/api/raw/slides/001.svg`);

  const opacityOf = (selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel) as SVGElement | null;
      if (!el) return null;
      return getComputedStyle(el).opacity;
    }, selector);

  await expect.poll(() => opacityOf("#el-title")).toBe("1");
  await expect.poll(() => opacityOf("#el-fade-in")).toBe("1");
  await expect.poll(() => opacityOf("#el-appear-in")).toBe("1");
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
