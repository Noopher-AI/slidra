import { access, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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
 * 播放模式 end to end (issue #28): entering play, stepping through effects
 * with the keyboard, advancing past a slide's last step, leaving play, and
 * the two static-safety guarantees the spec requires (story 20: a slide
 * opened directly in a browser shows every element; the underlying file's
 * bytes never change across a play session). The hand-written fixture is
 * `fixtures/play-deck/` — real effect lists, real steps, nothing generated.
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

  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-playmode-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-e2e-playmode-files-"));
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

  await page.locator('button:has-text("播放")').click();

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
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("");

  expect(pageErrors).toEqual([]);

  const after001 = await readSlideText(presentationId, "slides/001.svg");
  const after002 = await readSlideText(presentationId, "slides/002.svg");
  expect(sha256(after001)).toBe(sha256(before001));
  expect(sha256(after002)).toBe(sha256(before002));
  expect(after001).toBe(before001);
  expect(after002).toBe(before002);
});

it("焦點不在播放器上時，畫面明確說明並提供點回去的方式", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("播放第一頁");

  await page.locator('button:has-text("播放")').click();
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toContain("allow-scripts");

  // Unlike the SVG elements above, this notice is not hidden with opacity
  // — it is a plain React-conditional element, mounted only while
  // `playerHasFocus` is false. "Visible"/"hidden" for it means
  // present/absent in the DOM, so this checks `.count()`, not opacity
  // (which would read "1" the whole time regardless, since the mounted
  // element carries no opacity style at all).
  const notice = page.locator(".player-focus-notice");

  // Entering play mode hands focus to the player asynchronously (the
  // runtime posts "ready" once its own listeners are attached, and only
  // then does canvas.ts call focusPlayer() — see the ready handler in
  // canvas.ts). Racing that with "steal focus" below, before it has had a
  // chance to land, made this test flicker during development: the notice
  // would show only for an instant and then get hidden again by the
  // delayed initial auto-focus, independent of anything this test did.
  // Waiting for that initial settle first — the notice must be *absent*
  // once play mode has truly taken focus — makes the rest of this test
  // deterministic.
  await expect.poll(() => notice.count(), { timeout: 10_000 }).toBe(0);

  // Steal focus away from the player onto something else in the parent document.
  await page.locator('button:has-text("離開播放")').focus();
  await expect.poll(() => notice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

  // `window.focus()` only reliably moves focus in response to a *trusted*
  // user gesture (browsers deliberately ignore it otherwise, the same
  // anti-focus-stealing rule that blocks unsolicited popups) — a
  // programmatic `element.click()` is untrusted and was observed, during
  // this ticket's work, to leave focus exactly where it started. A real
  // Playwright `locator.click()` is trusted but its actionability wait can
  // itself get caught in "element was detached, retrying" here, because
  // the very click this test is making unmounts the notice mid-action —
  // so this dispatches a real mouse click at the button's last known
  // position instead, sidestepping the retry loop while still producing a
  // trusted event.
  const box = await page.locator(".player-focus-notice button").boundingBox();
  if (!box) throw new Error("找不到「點回去」按鈕的座標");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => notice.count(), { timeout: 10_000 }).toBe(0);
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
