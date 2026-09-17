// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Locator } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { deckPathFor } from "../packages/server/src/slidra/home.js";
import { readDeckFileText, writeDeckFileText } from "./helpers/deck.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * The fullscreen toggle end to end: the toggle only exists in play mode,
 * both directions actually change `document.fullscreenElement` and the real
 * measured size (never trusting a resolved promise alone — see
 * e2e/fullscreen-spike.test.ts, whose evidence this unit's approach rests
 * on), arrow-key advance keeps working in both states, Esc returns to
 * embedded play without leaving play mode, and fullscreen survives changing
 * pages because the iframe element is not replaced by one (only its
 * `srcdoc` is). Reuses the same hand-written fixture as
 * e2e/player-mode.test.ts (`fixtures/play-deck/`), read-only.
 *
 * The fullscreen target is `.canvas-area` — the container that holds both
 * the iframe and the play chrome `<nav>` — not the iframe itself. An earlier
 * design fullscreened the iframe directly and discovered, by hand, that a
 * real click can never land on anything in the parent chrome once the
 * iframe sits alone in the browser's fullscreen top layer (`locator.click()`
 * timed out with "intercepts pointer events" on both the fullscreen-toggle
 * button and the exit-play button). Fullscreening the shared container
 * fixes that: the chrome buttons are now descendants of the fullscreen
 * element, so they stay real, clickable DOM nodes. This suite's tests
 * exercise both directions with genuine `locator.click()` calls precisely
 * to prove that gap is closed, not merely reasoned about.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/play-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let slidraHome: string;
let slidraDir: string;
let registry: CommandRegistry;
let server: RunningServer;
let presentationId: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, run npm run build first");

  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-fullscreen-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-fullscreen-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  registry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "play-deck.slidra");
  await packDirectory(deckFixtureDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test never sends a message",
    },
  };

  server = await startServe({ presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  if (slidraHome) await rm(slidraHome, { recursive: true, force: true });
  if (slidraDir) await rm(slidraDir, { recursive: true, force: true });
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

it("the fullscreen toggle is only offered in play mode; this control does not exist in view mode", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  // View mode: the control doesn't exist (not hidden, absent from the DOM).
  expect(await page.locator(".fullscreen-toggle-button").count()).toBe(0);

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  await expect.poll(() => page.locator(".fullscreen-toggle-button").count()).toBe(1);
  // Whether to go fullscreen is the author's choice — starting play does not
  // auto-enter fullscreen: the button text reads "Fullscreen" (the action to
  // enter), not "Exit fullscreen".
  expect(await page.locator('button:has-text("Fullscreen")').count()).toBe(1);
  expect(await page.locator('button:has-text("Exit Fullscreen")').count()).toBe(0);
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

it("clicking the button really enters fullscreen (container fills the screen, iframe inside the container), and clicking again really exits", async () => {
  // This test verifies "entering fullscreen really makes the display bigger"
  // by comparing the iframe size before and after fullscreen — a comparison
  // that's only meaningful if the pre-fullscreen size is genuinely smaller
  // than the post-fullscreen one. 1024×640 (a 1.6 ratio) is deliberately not
  // fixtures/play-deck/'s canvas ratio of 16:9: once play mode's full-bleed
  // fix landed, the non-fullscreen stage is already truly full-bleed — at a
  // 16:9 viewport, the full-bleed size happens to equal the whole viewport,
  // identical to after entering fullscreen, so "growth" as a proxy metric
  // couldn't measure any difference (a real case that only surfaced after
  // that fix landed, see the PR body). Here, headless Chromium's screen size
  // always equals the viewport (verified), so what restores meaning to the
  // assertion isn't "viewport smaller than screen" — that condition never
  // holds in this harness to begin with — but "viewport aspect ratio is not
  // 16:9": at a non-16:9 ratio the stage letterboxes to the canvas ratio,
  // and fullscreen's `.canvas-area:fullscreen` rule removes the letterbox
  // and lets the iframe fill the container, so the before/after sizes
  // genuinely differ. If this value is ever changed back to any 16:9 ratio
  // (e.g. 1280×720), this assertion would silently become always-true or
  // always-false — confirm the new value isn't 16:9 before changing it.
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  // Sandbox posture asserted, never just commented (ADR-0007): allow-scripts
  // for the runtime, never allow-same-origin alongside it. Unaffected by
  // switching the fullscreen target — canvas.ts (untouched) still owns the
  // iframe's sandbox attribute.
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
  await expect.poll(() => page.locator('button:has-text("Exit Fullscreen")').count()).toBe(1);

  // The point of the container-based design: this second click must
  // be a genuine Playwright click landing on a real, on-screen button — no
  // evaluate()-driven .click() call, no mouse-position workaround. The
  // fullscreen-toggle button is now inside the fullscreen element
  // (.canvas-area), so it stays reachable.
  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => page.locator('button:has-text("Fullscreen")').count()).toBe(1);
});

it("arrow-key advance works normally in both states; Esc-triggered exit fullscreen returns to embedded play instead of dropping out of play mode", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  // Wait for play mode to actually take over the screen (both enter
  // elements hidden by the runtime) before sending arrow keys, otherwise a
  // key press might fire before the new play iframe is ready.
  await expectHidden(fadeText);
  await expectHidden(appearText);
  // Entering play hands focus to the player: advancing works without clicking first.
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);
  await expectHidden(appearText);

  // Arrow-key advance works normally in embedded play.
  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // Arrow-key advance works normally in fullscreen too — focusPlayer() must
  // always be called after toggling fullscreen, or arrow keys silently stop
  // working here.
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

  // Exiting fullscreen (including via Esc) returns to embedded play instead
  // of dropping out of play mode: the exit-play button is still there
  // (mode is still play), and arrow keys can still advance to the next page.
  await expect.poll(() => page.locator('button:has-text("Exit Play")').count()).toBe(1);
  const secondTitle = playFrame().locator("#el-title2");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 30_000 }).toBe("Play Slide 2");
});

it("fullscreen survives a page change: the iframe element itself is never swapped, only its srcdoc changes, and the container stays the fullscreen element", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
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

  // Advance two steps to reach slide 2 (fade -> appear -> advance-past-end).
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);
  await page.keyboard.press("ArrowRight");
  await expectVisible(appearText, 10_000);
  const secondTitle = playFrame().locator("#el-title2");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 30_000 }).toBe("Play Slide 2");

  // After the page change: the iframe element was not swapped (the marker
  // is still there), the container is still the fullscreen element, and the
  // iframe is still inside the container, still filling it.
  const stillSameElement = await page.evaluate(() => {
    const frame = document.querySelector("iframe.slide-frame") as HTMLIFrameElement & { __marker?: string };
    return frame.__marker === "same-element";
  });
  expect(stillSameElement).toBe(true);
  const after = await fullscreenSnapshot(page);
  expect(after.isContainerFullscreen).toBe(true);
  expect(after.frameIsInsideFullscreenElement).toBe(true);

  // Arrow keys still work normally after the page change, even while already in fullscreen on slide 2.
  const secondFade = playFrame().locator("#el-second-fade");
  await expectHidden(secondFade);
  await page.keyboard.press("ArrowRight");
  await expectVisible(secondFade, 10_000);
});

it("exiting play while fullscreen: a real button click exits it, the document never gets stuck fullscreen", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const fadeText = page.frameLocator("iframe.slide-frame").locator("#el-fade-in");

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  await expectHidden(fadeText);

  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // Genuine click on a real, reachable button — the point of moving the
  // fullscreen target to the shared container: the exit-play button is a
  // descendant of it, so a real Playwright click lands on it even while
  // fullscreen (an earlier design had to fall back to el.click() here
  // because a real click timed out).
  await page.locator('button:has-text("Exit Play")').click();

  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  // ADR-0007: view mode now runs a script too (selection-runtime.js), so
  // the sandbox no longer goes back to "" here. What this line pins is
  // that it carries only allow-scripts — never allow-same-origin.
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("allow-scripts");
});

// A test for "the play-error and fullscreen-error notices are both visible
// side by side without overlapping" used to live here, but this fixture
// cannot produce a play error, so it was actually improvising a second
// notice out of the focus notice. After the focus notice was removed, that
// measurement moved to e2e/play-appearance.test.ts — that file's
// broken-effects deck lets the two real notices coexist stably, which is
// easier to measure than the original ~100ms coexistence window, and proves
// the same thing.

it("after successfully exiting fullscreen from outside, a stale fullscreen-failure message gets cleared", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  // Get into a genuinely fullscreen state, so "exiting" has real meaning (not a fabricated isFullscreen).
  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // Forcing exitFullscreen() to fail as a precondition is hard to produce
  // with real gestures in a genuine engine without faking it (headless
  // Chromium has no legal sequence of operations that makes
  // document.exitFullscreen() reject while the document is genuinely
  // fullscreen — the spec guarantees success in that case). Using an honest
  // alternative instead: monkey-patch document.exitFullscreen to return a
  // one-shot rejected promise, so toggleFullscreen()'s catch branch is
  // actually reached (that code path itself is real; only the browser API's
  // return value is swapped out, simulating "the engine refuses to exit" —
  // a case the spec allows for but that this test environment cannot force
  // otherwise). The browser's real fullscreen state is completely untouched
  // at this point — the call never actually reaches the underlying API, so
  // the document genuinely stays fullscreen.
  await page.evaluate(() => {
    const doc = document as Document & {
      __originalExitFullscreen?: () => Promise<void>;
      webkitExitFullscreen?: () => Promise<void>;
    };
    doc.__originalExitFullscreen = (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.bind(doc);
    doc.exitFullscreen = () => Promise.reject(new Error("simulated test: Exit Fullscreen rejected"));
  });

  // Real click on the "exit fullscreen" button — since isFullscreen is
  // true at this point, this button's onClick really calls the (patched)
  // exitFullscreen(), reaching the catch branch.
  await page.locator(".fullscreen-toggle-button").click();
  const fullscreenErrorNotice = page.locator(".player-error-notice", { hasText: "Fullscreen toggle failed" });
  await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBe(1);
  // Success must not be faked when an error occurs: the UI must still
  // report fullscreen (the real browser state genuinely is still
  // fullscreen — the call above never actually reached the underlying API).
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 5_000 })
    .toBe(true);

  // Restore the real exitFullscreen, then use it to trigger a genuine,
  // successful exit fullscreen — equivalent to the technique this file's
  // other tests use to stand in for Esc. This call really does make the
  // browser leave fullscreen, and really does fire a fullscreenchange event.
  await page.evaluate(() => {
    const doc = document as Document & { __originalExitFullscreen?: () => Promise<void> };
    if (doc.__originalExitFullscreen) doc.exitFullscreen = doc.__originalExitFullscreen;
    return doc.exitFullscreen();
  });

  // Before the fix: the fullscreenchange handler only updated isFullscreen,
  // and the stale failure message stayed on screen. After the fix: this
  // real, successful fullscreenchange must clear it.
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => fullscreenErrorNotice.count(), { timeout: 10_000 }).toBe(0);
});

it("if requestFullscreen() is still pending when exiting play, the document does not end up stuck fullscreen", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  // Delays the real underlying requestFullscreen() call itself, not just the
  // promise wrapping it — it really does enter fullscreen, only later. Only
  // artificially delaying the returned promise while letting the real call
  // fire immediately would not reproduce this race at all: the real
  // fullscreenchange event (and this app's isFullscreen state) would still
  // land right away, regardless of how long our own promise is stalled.
  // The setTimeout here defers the actual native call itself by 300ms; it
  // still runs soon enough to be within the click's transient activation
  // window, so it remains a real, successful fullscreen request — just a
  // late one, exactly the in-flight window this test targets.
  //
  // A handle to the delayed call's own settlement is stashed on the
  // container (`__delayedFullscreenSettled`) — an earlier version of this
  // test polled for "not fullscreen" starting immediately after the two
  // clicks. At that instant the delayed native call has not fired yet, so
  // `fullscreenElement` is still null for the same reason it would be null
  // before any bug existed — `expect.poll(...).toBe(false)` accepts the
  // very first sample and returns instantly, never actually observing the
  // moment (t≈300ms) the race is about. That made the test pass
  // unconditionally, with or without the fix. Waiting on this handle first
  // guarantees the check below only starts once the real transition has
  // already happened.
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
  // race is about — a real click on the exit-play button.
  await page.locator('button:has-text("Exit Play")').click();

  // Wait until the delayed native requestFullscreen() call has actually
  // landed (t ≥ 300ms) before checking anything at all: only after this
  // await do we know the race's critical moment has genuinely passed, so a
  // poll started from here on is measuring the real aftermath, not a
  // pre-race snapshot.
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

  // Stability, not just "eventually false once": sample a few more times
  // over a short window to make sure it does not flip back to fullscreen.
  // A genuinely fixed run never does; this only guards against asserting
  // on a value that happens to be false for one instant
  // mid-transition.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(100);
    expect(await readFullscreen()).toBe(false);
  }

  // Exiting play itself must also genuinely complete, not get stuck halfway: the screen returns to view mode's "Play" button.
  await expect.poll(() => page.locator('.play-button').count()).toBe(1);
});

it("when fullscreen entry is rejected, clicking the toggle still hands focus back to the player", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  // After the focus notice was removed, whether the player has focus is
  // read from .play-bar's data-player-focus instead — the same
  // playerHasFocus state, just no longer surfaced to the author.
  const playBar = page.locator(".play-bar");
  // Wait for the initial auto-focus to settle first (same reasoning as the earlier tests), then steal focus ourselves.
  await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("true");
  await page.locator('button:has-text("Exit Play")').focus();
  await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("false");

  // One-time measurement: remove both fullscreen APIs from the container, to
  // prove the "fullscreen unsupported" early-return path is actually
  // reachable, not permanently dead code — this is the only way to reach
  // that `if (!request) { ...; return; }` branch inside toggleFullscreen().
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      requestFullscreen?: unknown;
      webkitRequestFullscreen?: unknown;
    };
    Object.defineProperty(container, "requestFullscreen", { value: () => Promise.reject(new Error("This browser doesn't support Fullscreen")), configurable: true });
    Object.defineProperty(container, "webkitRequestFullscreen", { value: undefined, configurable: true });
  });

  await page.locator(".fullscreen-toggle-button").click();

  // This path is reached: the notice carries the rejection's own message,
  // the same wording the unsupported branch uses ("doesn't", not "does not").
  const unsupportedNotice = page.locator(".player-error-notice", { hasText: "This browser doesn't support Fullscreen" });
  await expect.poll(() => unsupportedNotice.count(), { timeout: 10_000 }).toBe(1);

  // Before the fix: this early return never called focusPlayer(), so focus
  // stayed on the button. After the fix: even when fullscreen is
  // unsupported, focus must still return to the player.
  await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("true");
});

it("sent first, arrives first: an earlier request settling first must not clear a later one still in flight", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  // Give the two calls different delays: the first lands at 100ms, the
  // second at 600ms — producing the order "the earlier request settles
  // first, the later one is still in flight". Each call leaves behind an
  // awaitable handle (settled[0]/settled[1]), so the test can precisely wait
  // for the window "the first has landed, the second hasn't" without
  // guessing a timing.
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

  // Two real clicks, both within the window where isFullscreen is still
  // false (the real browser state only changes once the delayed call
  // lands), so both enter toggleFullscreen()'s "enter" branch, each
  // capturing its own promise into fullscreenRequestRef.
  await page.locator(".fullscreen-toggle-button").click();
  await page.locator(".fullscreen-toggle-button").click();

  // Wait for the first (earlier) request to actually land (t≈100ms) — this
  // is exactly the moment the old unconditional cleanup would have
  // incorrectly cleared fullscreenRequestRef to null, even though the
  // second request (which only lands at t≈600ms) hasn't finished at all.
  await page.evaluate(() => {
    const container = document.querySelector(".canvas-area") as HTMLElement & {
      __settled?: Array<Promise<unknown>>;
    };
    return container.__settled?.[0];
  });

  // Before the fix: the first request's finally unconditionally cleared
  // fullscreenRequestRef to null, so clicking "exit play" here made
  // handleExitPlay() find no pending request to wait for, so it would
  // immediately judge by the current real fullscreenElement (which doesn't
  // yet reflect the second request) — usually still not fullscreen at this
  // point — and exit play directly without exiting fullscreen; once the
  // second request genuinely lands at t≈600ms, the document ends up stuck
  // fullscreen with no play chrome left to click out of it. After the fix:
  // the first request settling doesn't touch a ref that already points to
  // the second request, so exiting play can still find the (second) pending
  // request to wait for.
  await page.locator('button:has-text("Exit Play")').click();

  // Wait for the second (later) request to genuinely land too before
  // checking the final state — the same principle as before: don't sample
  // before the transition has actually happened.
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
  // A stable state, not just a sample that happened to be false at a single instant.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(100);
    expect(await readFullscreen()).toBe(false);
  }

  await expect.poll(() => page.locator('.play-button').count()).toBe(1);
});

it("when a live reload removes the last slide, the exit-play and fullscreen toggle buttons are still visible and clickable", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("Play Slide 1");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  await page.locator(".fullscreen-toggle-button").click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(true);

  // A genuine external edit: rewrite this presentation's actual deck file
  // on disk directly (the one `open` migrated/registered — not the
  // read-only shared fixture at e2e/fixtures/play-deck), emptying out its
  // slides, so this genuinely exercises the server's file watch -> SSE
  // presentation-changed -> canvas.ts's reload() live-reload path end to
  // end, rather than simulating it.
  const deckPath = await deckPathFor(presentationId);
  const original = await readDeckFileText(deckPath, "project.json");
  const emptied = JSON.parse(original) as { slides: string[] };
  emptied.slides = [];
  await writeDeckFileText(deckPath, "project.json", JSON.stringify(emptied, null, 2));

  // Wait for the reload to actually land instead of guessing a timing
  // before asserting: canvas.ts's renderPlay() renders this fixed text when
  // currentIndex === -1 (slides genuinely empty), which is an observable,
  // non-guessed signal that the reload has landed.
  await expect
    .poll(() => page.locator(".stage-empty").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toContain("No slides now");

  // Before the fix: hasSlides became false, the whole <nav> disappeared,
  // and neither exit-play nor the fullscreen toggle were on screen anymore,
  // with nothing having actively exited fullscreen — the author was left in
  // a blank fullscreen screen with no built-in App exit, only the browser's
  // own Esc. After the fix: both buttons are still there.
  await expect.poll(() => page.locator('button:has-text("Exit Play")').count()).toBe(1);
  await expect.poll(() => page.locator(".fullscreen-toggle-button").count()).toBe(1);

  // Fullscreen itself was not silently, forcibly exited without the
  // author's consent — whether to leave fullscreen is still the author's
  // decision, not one made for them by the slide count.
  expect((await fullscreenSnapshot(page)).isContainerFullscreen).toBe(true);

  // A real click on exit-play, proving it isn't merely present in the DOM
  // but is genuinely clickable — also exercising handleExitPlay()'s
  // existing logic once, confirming fullscreen exits along with it.
  await page.locator('button:has-text("Exit Play")').click();
  await expect
    .poll(() => fullscreenSnapshot(page).then((s) => s.isContainerFullscreen), { timeout: 15_000 })
    .toBe(false);
  await expect.poll(() => page.locator('button:has-text("Exit Play")').count()).toBe(0);
});
