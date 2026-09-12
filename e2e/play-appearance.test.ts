import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Play mode appearance: pure black full-bleed stage, the floating control
 * bar (previous/next/page number/fullscreen/exit play), the idle-hide of
 * both cursor and control bar together, and the survival of the three
 * floating notices through that idle-hide. `demo/` is used for the
 * control-bar/idle tests (no effect list to fight the paging assertions);
 * `fixtures/broken-effects-deck/` is reused from
 * e2e/player-effect-error.test.ts for the one test that needs a real
 * `.player-error-notice` on screen.
 *
 * Viewport fixed at 1440×900, same as e2e/appearance.test.ts and
 * docs/design/base-shell.html's own static frame (which is always rendered
 * at a 1440×900 window).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "demo");
const brokenEffectsDeckDir = path.join(e2eDir, "fixtures/broken-effects-deck");
const playDeckDir = path.join(e2eDir, "fixtures/play-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist does not exist, run npm run build first");

  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

async function startServerFor(
  deckDir: string,
  prefix: string,
): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), `slidra-e2e-${prefix}-home-`));
  const slidraDir = await mkdtemp(path.join(tmpdir(), `slidra-e2e-${prefix}-files-`));
  process.env["SLIDRA_HOME"] = slidraHome;
  // slidra serve spawns the Rust binary for every read/write.
  process.env["SLIDRA_BIN"] = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, `${prefix}.slidra`);
  await packDirectory(deckDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test never sends a message",
    },
  };

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    cleanup: async () => {
      await server.close();
      delete process.env["SLIDRA_HOME"];
      delete process.env["SLIDRA_BIN"];
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
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

/** Loads the app and waits for the first slide to actually be painted before returning the page. */
async function openApp(deckDir: string, prefix: string): Promise<{ page: Page; cleanup: () => Promise<void> }> {
  const { server, cleanup } = await startServerFor(deckDir, prefix);
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(() => document.fonts.ready);

  return { page, cleanup };
}

/**
 * Same wait as e2e/player-media.test.ts's own waitForPlayerFocus: the
 * play iframe is torn down and rebuilt with `allow-scripts` on entering
 * play, and a click/keypress fired before the fresh runtime posts "ready"
 * has no listener to reach.
 */
async function enterPlay(page: Page): Promise<void> {
  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
}

it("the control bar's previous/next buttons change the slide itself, not a step in the effect list", async () => {
  // demo/'s four slides all carry no effect list, so the claim "next changes
  // the slide, not an effect step" cannot be measured against a deck with no
  // effect steps to advance through — even if the control bar were wired to
  // step through player-runtime's effect steps by mistake, the behavior
  // measured on demo/ would look identical to calling controller.next(), and
  // the test would stay green under the wrong implementation. Using
  // fixtures/play-deck/ instead (the fixture player-mode.test.ts already
  // validates): slide 1 has two enter effect steps (fadeText/appearText)
  // that need two arrow-key presses to fully apply, with the third changing
  // the slide; the control bar's "next" must jump straight to slide 2 on a
  // single press, with neither effect step applied at all — that is the
  // shape that actually measures "changing slides does not change effect
  // steps".
  const { page, cleanup } = await openApp(playDeckDir, "play-appearance-nav");
  try {
    await enterPlay(page);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const fadeOpacity = () =>
      playFrame().locator("#el-fade-in").evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
    const titleText = () => playFrame().locator("#el-title").textContent().catch(() => null);
    const title2Text = () => playFrame().locator("#el-title2").textContent().catch(() => null);

    await expect.poll(titleText, { timeout: 30_000 }).toBe("播放第一頁");
    // On entry neither enter element is applied yet (same existing check as
    // player-mode.test.ts).
    await expect.poll(fadeOpacity).toBe("0");

    // Click "next" once: if it really is controller.next() (showSlide(+1)),
    // it jumps straight to slide 2, completely skipping slide 1's two
    // remaining effect steps.
    await page.locator('.play-bar button[aria-label="下一步"]').click();
    await expect.poll(title2Text, { timeout: 30_000 }).toBe("播放第二頁");
    // No arrow key was pressed, and there was no intermediate "applying"
    // state — slide 1's fade-in element was simply swapped out along with
    // the whole document (changing pages in the play iframe reassigns the
    // whole srcdoc, not an in-place update within the same document, see
    // canvas.ts).

    // Click "previous" once: switches back to slide 1, page number and
    // disabled state stay in sync (the template's `N / M` form; play-deck
    // only has 2 slides).
    await page.locator('.play-bar button[aria-label="上一步"]').click();
    await expect.poll(titleText, { timeout: 30_000 }).toBe("播放第一頁");
    expect(await page.locator(".play-bar-position").textContent()).toBe("1 / 2");
    expect(await page.locator('.play-bar button[aria-label="上一步"]').isDisabled()).toBe(true);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("the control bar's child node order matches the template (previous/page number/next/divider/fullscreen/exit play), and it is centered at the bottom", async () => {
  // Fullscreen/exit play were once reversed in order (the template has
  // "fullscreen, exit play"), and every existing e2e selector for
  // `.play-bar` is an aria-label or class (see every `.play-bar ...` usage
  // in this file and in player-effect-error.test.ts/player-media.test.ts) —
  // none of them guards the child nodes' actual order, which is exactly why
  // this deviation went unnoticed for a while. This reads `.play-bar`'s DOM
  // children directly, converts each in order to a recognizable name, and
  // compares against the template (base-shell.html:419-426, an order
  // measured with Playwright at 1440×900) one by one, turning the order
  // into a contract actually enforced by an assertion rather than relying
  // on eyeballing the JSX. The page-number position was also moved from
  // "after previous/next" to "between previous and next" (the prototype's
  // actual order), and the control bar was moved from bottom-left to
  // bottom-center — this adds the horizontal-centering geometry assertion
  // alongside it, both contracts enforced here for the first time.
  const { page, cleanup } = await openApp(demoDir, "play-appearance-order");
  try {
    await enterPlay(page);

    const order = await page.locator(".play-bar").evaluate((el) =>
      Array.from(el.children).map((child) => {
        if (child.classList.contains("play-bar-position")) return "pos";
        if (child.classList.contains("play-bar-divider")) return "divider";
        const ariaLabel = child.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;
        return child.textContent?.trim() ?? child.tagName;
      }),
    );
    expect(order).toEqual(["上一步", "pos", "下一步", "divider", "全螢幕", "離開播放"]);

    const barBox = await page.locator(".play-bar").boundingBox();
    const canvasAreaBox = await page.locator(".canvas-area").boundingBox();
    expect(barBox).not.toBeNull();
    expect(canvasAreaBox).not.toBeNull();
    const barCenterX = barBox!.x + barBox!.width / 2;
    const canvasCenterX = canvasAreaBox!.x + canvasAreaBox!.width / 2;
    expect(Math.abs(barCenterX - canvasCenterX)).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("cursor and control bar hide together after 2.5s idle, and moving the mouse inside the slide area also brings them back", async () => {
  // The slide iframe covers most of the play screen's area, and is where an
  // author would most naturally move their mouse. An earlier version of
  // this test worked around the limitation that "a mousemove crossing a
  // frame boundary does not bubble to the parent document" by moving the
  // mouse to the narrow strip next to the control bar instead
  // (`page.mouse.move(60, 850)`), rather than reporting it — the test's name
  // says "moving the mouse", but the assertion only ever covered one small
  // safe zone. This version makes "inside the slide area" the primary path,
  // keeping the original "outside the slide" as a control case at the end.
  const { page, cleanup } = await openApp(demoDir, "play-appearance-idle");
  try {
    await enterPlay(page);

    const app = page.locator(".app");
    const bar = page.locator(".play-bar");
    const opacityOf = (locator: typeof bar) => locator.evaluate((el) => getComputedStyle(el).opacity);
    const cursorOf = () => app.evaluate((el) => getComputedStyle(el).cursor);

    const iframeBox = await page.locator("iframe.slide-frame").boundingBox();
    if (!iframeBox) throw new Error("could not find the play iframe's bounding box");
    // Logged for reference: the iframe size measured at a 1440×900 viewport
    // (a prior measurement was 1415.11×795.98; sub-pixel differences across
    // runs are fine as long as the order of magnitude matches).
    console.log(`iframe box: ${JSON.stringify(iframeBox)}`);
    const iframeCenter = { x: iframeBox.x + iframeBox.width / 2, y: iframeBox.y + iframeBox.height / 2 };

    // Right after entering play: control bar visible, cursor normal.
    await expect.poll(() => opacityOf(bar)).toBe("1");
    expect(await cursorOf()).toBe("default");

    // Idle for over 2.5s: both hide together.
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("0");
    expect(await cursorOf()).toBe("none");

    // Primary path: move the mouse INSIDE the slide area.
    // `.play-mousemove-catcher` (PlayChrome/play.css) sits on top of the
    // iframe and catches this mousemove, letting it bubble to the parent
    // document instead of being dispatched directly into the iframe's own
    // document by the browser.
    await page.mouse.move(iframeCenter.x, iframeCenter.y);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("1");
    expect(await cursorOf()).toBe("default");

    // Keep moving inside the slide area (not just moving once and stopping),
    // to confirm the idle timer really is reset every time and the control
    // bar does not flicker off on its own before 2.5s elapses — direct
    // evidence that the overlay bubbles up EVERY mousemove, not just the
    // first. Three moves, 1.2s apart (< the 2.5s idle threshold), should all
    // keep opacity at "1" without ever reverting to "0" in between.
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1200);
      await page.mouse.move(iframeCenter.x + i + 1, iframeCenter.y);
      expect(await opacityOf(bar)).toBe("1");
    }

    // Control case: move near the control bar, clearly outside the slide
    // iframe — the parent document's own mousemove already bubbles to
    // document on its own, so this path worked from the start; kept here to
    // prove the overlay did not accidentally block this already-working path.
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("0");
    await page.mouse.move(60, 850);
    await expect.poll(() => opacityOf(bar), { timeout: 5_000 }).toBe("1");
    expect(await cursorOf()).toBe("default");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("clicking the slide area still hands focus back to the player (the overlay's compensation after intercepting the click)", async () => {
  // A problem introduced by the change itself: the overlay's
  // pointer-events:auto intercepts clicks in the slide area, so the native
  // "clicking the iframe gives it browser focus" no longer happens.
  // PlayChrome compensates with controller.focusPlayer() — this verifies the
  // compensation actually holds, not just trusting the code by reading it.
  // The overlay's onClick now also does one more thing besides
  // focusPlayer(): it calls stepPlayer("advance") (the prototype's "clicking
  // the screen advances"). That does not affect the focus-recovery this test
  // checks; if a future reader sees the presentation here also advance a
  // step, that is new behavior, not a regression.
  const { page, cleanup } = await openApp(demoDir, "play-appearance-focus-click");
  try {
    await enterPlay(page);

    // Steal focus (reusing the technique already validated in
    // e2e/player-fullscreen.test.ts).
    const playBar = page.locator(".play-bar");
    await page.locator('button:has-text("離開播放")').focus();
    await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("false");

    // Click in the center of the slide area — this coordinate lands on
    // .play-mousemove-catcher, not a click that natively lands in the iframe.
    const box = await page.locator(".canvas-area").boundingBox();
    if (!box) throw new Error("could not find .canvas-area's bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("true");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("both floating notices (play error/fullscreen error) are visible side by side without overlapping, and remain visible after the control bar hides", async () => {
  const { page, cleanup } = await openApp(brokenEffectsDeckDir, "play-appearance-notices");
  try {
    await page.locator('.play-button').click();

    // Play error: this deck's slide 1 effect list is guaranteed to fail
    // parsing (see e2e/player-effect-error.test.ts). canvas.ts's
    // parse-failure path (see renderPlay's catch branch) swaps the srcdoc
    // for a static version with no player-runtime, so this slide never sends
    // "ready".
    //
    // After the focus notice was removed, only these two notice kinds
    // remain. The focus notice would have held alongside this failure
    // (playerHasFocus stuck at false), but it was never what this test needs
    // to prove — the point is "notices do not hide along with the control
    // bar", which both notice kinds equally demonstrate.
    const errorNotice = page.locator(".player-error-notice", { hasText: "效果清單" });
    await expect.poll(() => errorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await page.locator(".player-focus-notice").count()).toBe(0);

    // Fullscreen error: reusing the technique already validated in
    // e2e/player-fullscreen.test.ts — produce a real error with a
    // requestFullscreen stub that is guaranteed to reject (not faking
    // success and then lying about failure), then click the fullscreen button.
    await page.evaluate(() => {
      const container = document.querySelector(".canvas-area") as HTMLElement;
      container.requestFullscreen = () => Promise.reject(new Error("模擬測試：全螢幕請求被拒絕"));
    });
    await page.locator(".play-bar .fullscreen-toggle-button").click();
    const fullscreenErrorNotice = page.locator(".player-error-notice", { hasText: "全螢幕切換失敗" });
    await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // The two notices must not overlap each other: previously both used the
    // same position:absolute stacked at the same spot, so the later-rendered
    // one would cover the earlier one while isVisible() still reported true
    // (Playwright's visibility check ignores z-order) — so what actually
    // needs measuring is whether the real coordinate rectangles intersect.
    //
    // This measurement originally lived in e2e/player-fullscreen.test.ts,
    // using the "focus notice + fullscreen error" pair, because that
    // fixture cannot produce a play error. That pair only coexisted for
    // about 100ms (the notice unmounts as soon as focus is handed back), so
    // it needed frame-by-frame in-page sampling to measure accurately. After
    // the focus notice was removed, the measurement moved here — this
    // broken deck lets both notices coexist stably with no closing window,
    // and nothing unmounts between the two boundingBox() reads, so the
    // frame-by-frame sampling (and the race it guarded against) is no
    // longer needed.
    const errorBox = await errorNotice.first().boundingBox();
    const fullscreenBox = await fullscreenErrorNotice.first().boundingBox();
    if (!errorBox || !fullscreenBox) throw new Error("both notices must have a real size to measure overlap");
    const overlaps =
      errorBox.x < fullscreenBox.x + fullscreenBox.width &&
      errorBox.x + errorBox.width > fullscreenBox.x &&
      errorBox.y < fullscreenBox.y + fullscreenBox.height &&
      errorBox.y + errorBox.height > fullscreenBox.y;
    expect(overlaps).toBe(false);

    const opacityOf = (locator: ReturnType<Page["locator"]>) =>
      locator.first().evaluate((el) => getComputedStyle(el).opacity);

    // The notices themselves aren't inside .play-bar, and the idle-hide rule
    // only applies to .play-bar, so both notices should stay visible after
    // the control bar hides — they're errors, not chrome. No more mouse
    // movement here (the evaluate()/click() above were the last interaction);
    // just wait out the idle timer.
    await page.waitForTimeout(2800);
    await expect.poll(() => opacityOf(page.locator(".play-bar")), { timeout: 5_000 }).toBe("0");
    expect(await opacityOf(errorNotice)).toBe("1");
    expect(await opacityOf(fullscreenErrorNotice)).toBe("1");
  } finally {
    await page.close();
    await cleanup();
  }
});

it("in play mode, the dock, thumbnail rail, chat, notes, and status bar are all absent from the DOM", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-dom");
  try {
    // Before entering play: all of these elements are present (the standard
    // view's existing shell). Checking DOM count, not visibility — the spec
    // explicitly requires "absent from the DOM", where `display:none` /
    // `opacity:0` don't count, only querySelector/count === 0 does.
    expect(await page.locator(".titlebar").count()).toBe(1);
    expect(await page.locator(".dock").count()).toBe(1);
    expect(await page.locator(".overview").count()).toBe(1);
    expect(await page.locator(".overview-list").count()).toBe(1);
    expect(await page.locator(".chat-sidebar").count()).toBe(1);
    expect(await page.locator(".notes").count()).toBe(1);
    expect(await page.locator(".status-bar").count()).toBe(1);

    await enterPlay(page);

    expect(await page.locator(".titlebar").count()).toBe(0);
    expect(await page.locator(".dock").count()).toBe(0);
    expect(await page.locator(".overview").count()).toBe(0);
    expect(await page.locator(".overview-list").count()).toBe(0);
    expect(await page.locator(".chat-sidebar").count()).toBe(0);
    expect(await page.locator(".notes").count()).toBe(0);
    expect(await page.locator(".status-bar").count()).toBe(0);

    // Background is pure black, slide is centered and fully visible
    // (AC1/AC2): the stage's base is already #000 (styles/play.css's
    // existing `.canvas` rule); this measures the whole play blackout
    // container `.canvas-area`'s background color, confirming it isn't a
    // leftover stage-surface color.
    const bg = await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(0, 0, 0)");

    // `.notes` has already left the DOM (verified above), but `.main`'s
    // second track (shell.css's `grid-template-rows: 1fr var(--h-notes)`)
    // still reserves that space even with no `<Notes>`, leaving a
    // transparent strip that shows through to `.app`'s background
    // (`--s-well`, not black). The measurement here follows the same
    // approach: `.canvas-area`'s height should equal `.body`'s height (no
    // longer a bit short once the collapse succeeds), and the actually
    // rendered color at the bottom-center point of the viewport should be
    // black — not just trusting `.canvas-area`'s own background, since that
    // rule doesn't fill the extra space `.main`'s track leaves behind.
    const bodyHeight = await page.locator(".body").evaluate((el) => el.getBoundingClientRect().height);
    const canvasAreaHeight = await page.locator(".canvas-area").evaluate((el) => el.getBoundingClientRect().height);
    expect(canvasAreaHeight).toBe(bodyHeight);

    const viewport = page.viewportSize();
    if (!viewport) throw new Error("could not find the viewport size");
    // Use elementsFromPoint (the plural form) to get the whole stack and
    // find the first non-transparent background from top to bottom: the
    // topmost element at this point is .play-mousemove-catcher (transparent,
    // with no background of its own), so checking only what
    // elementFromPoint returns would misreport it as "transparent" and
    // never measure the real color underneath the glass. What the eye
    // actually sees at this point is the truly opaque layer beneath the
    // transparent overlay — this follows the same logic to look further down.
    const bottomCenterColor = await page.evaluate(
      ([x, y]) => {
        const stack = document.elementsFromPoint(x, y);
        for (const el of stack) {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        }
        return null;
      },
      [viewport.width / 2, viewport.height - 1] as const,
    );
    expect(bottomCenterColor).toBe("rgb(0, 0, 0)");

    // Already in play mode here (enterPlay() above), so this reuses the
    // existing session instead of a second startup —
    // `.stage` (overflow:hidden) must not have overflow content to clip in
    // the first place, and neither should the srcdoc iframe's own document.
    const stageScroll = await page.locator(".stage").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    }));
    expect(stageScroll.scrollWidth).toBeLessThanOrEqual(stageScroll.clientWidth);
    expect(stageScroll.scrollHeight).toBeLessThanOrEqual(stageScroll.clientHeight);
    const srcdocScroll = await page.frameLocator("iframe.slide-frame").locator("html").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    }));
    expect(srcdocScroll.scrollWidth).toBeLessThanOrEqual(srcdocScroll.clientWidth);
    expect(srcdocScroll.scrollHeight).toBeLessThanOrEqual(srcdocScroll.clientHeight);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("after leaving play mode, the overview thumbnail rail remounts and page changes still work by clicking (proof the overview module survives)", async () => {
  const { page, cleanup } = await openApp(demoDir, "play-appearance-overview-survival");
  try {
    // Enter play, then leave — `<Rail>` unmounts and remounts once.
    await enterPlay(page);
    await page.locator(".play-bar .play-toggle-button.leave").click();
    await expect.poll(() => page.locator(".play-button").count(), { timeout: 10_000 }).toBe(1);

    // Counting elements alone doesn't prove the module is still alive: click
    // a thumbnail and actually observe the slide change.
    const thumbnails = page.locator(".overview-thumb");
    await expect.poll(() => thumbnails.count(), { timeout: 10_000 }).toBe(4);

    const playFrame = () => page.frameLocator("iframe.slide-frame");
    const titleText = () => playFrame().locator("svg text").first().textContent().catch(() => null);
    const firstSlideText = await titleText();

    await page.locator('button[aria-label="Slide 2"]').click();
    await expect.poll(titleText, { timeout: 30_000 }).not.toBe(firstSlideText);
  } finally {
    await page.close();
    await cleanup();
  }
});

it("a slide with no background rect (a blank page from `slide add`) still renders an opaque white background in play mode instead of solid black", async () => {
  // `.canvas`'s (play.css, data-mode="play") #000 blackout is the
  // placeholder color before/while loading, meant to be covered by the
  // slide document. But a blank page from `slide add` has no background rect
  // (crates/slidra/src/slide/ops.rs's build_blank_slide_svg), and play mode
  // goes through renderPlay()'s normal path (canvas.ts's wrapPlayDocument) —
  // this measures the actually-playing iframe's own html/body background
  // directly, i.e. the wrap function the real play path actually uses.
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-play-nobg-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-play-nobg-files-"));
  process.env["SLIDRA_HOME"] = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env["SLIDRA_BIN"] = slidraBin;
  try {
    const registry: CommandRegistry = createDefaultRegistry();
    const slidraPath = path.join(slidraDir, "deck.slidra");
    await registry.dispatch("new", { path: slidraPath, name: "無背景播放測試" });
    const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
    const presentationId = opened.data!.id;
    // `new` creates no slides (ADR-0018); this test addresses slides/001.svg.
    await registry.dispatch("slide add", { id: presentationId });

    const agent: AgentAdapterConfig = {
      kind: "claude",
      label: "Claude Code",
      command: process.execPath,
      args: [agentFixture],
      env: {
        PATH: `${binDir}:${path.dirname(process.execPath)}`,
        E2E_PRESENTATION_ID: presentationId,
        E2E_NEW_TITLE: "this test never sends a message",
      },
    };
    const server = await startServe({ presentationId, port: 0, agent });
    try {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.goto(server.url);

      const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
      await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();

      await enterPlay(page);

      const playBody = page.frameLocator("iframe.slide-frame").locator("body");
      const bodyBackground = await playBody.evaluate((el) => getComputedStyle(el).backgroundColor);
      // The literal value the spec settled on ("opaque white background"):
      // not a snapshot reverse-engineered from the implementation. Only body
      // is measured — wrapPlayDocument() (canvas.ts) deliberately only
      // covers body with white, without touching html; wherever body isn't
      // filled, the browser's canvas background propagation rule naturally
      // carries body's color over, and html staying at its initial
      // transparent value is normal, expected behavior, not a defect.
      expect(bodyBackground).toBe("rgb(255, 255, 255)");

      await page.close();
    } finally {
      await server.close();
    }
  } finally {
    delete process.env["SLIDRA_HOME"];
    delete process.env["SLIDRA_BIN"];
    await rm(slidraHome, { recursive: true, force: true });
    await rm(slidraDir, { recursive: true, force: true });
  }
});
