// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

const execFileAsync = promisify(execFile);

/**
 * The acceptance criterion this test proves, verbatim: "the acceptance bar
 * isn't all tests passing green — it's that the hand-written deck actually
 * plays. Three pages, with a fade-in, a video, and audio, pressing the
 * arrow key all the way through, the author never leaving the screen."
 * That sentence describes the minimum SHAPE a hand-written deck must
 * demonstrate (fade, video, audio, one continuous keyboard walkthrough) —
 * it is not a page-count requirement on this specific `demo/` directory.
 * `demo/` predates this test and was already three pages, each page
 * carrying its own manual-acceptance purpose from earlier work (pagination,
 * assets, the effect list). A fourth page was added later for the media
 * effects rather than overloading one of those three with a second,
 * unrelated acceptance purpose. This test packs the repo's real `demo/`
 * directory (not a copy under `e2e/fixtures/`), opens it exactly the way
 * `scripts/quick_start.sh` does for a human, and walks the whole thing with real
 * `page.keyboard.press` calls — one continuous run from slide 1 to the
 * last step of slide 4, never leaving play mode. If a hand edit to
 * `demo/` ever breaks the walkthrough, this test goes red instead of the
 * breakage sitting undiscovered until a human happens to run
 * scripts/quick_start.sh.
 *
 * No autoplay-policy override: the real ArrowRight keypress below is the
 * real user gesture `play()` relies on.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const demoDir = path.join(rootDir, "docs/demo");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let slidraHome: string;
let slidraDir: string;
let registry: CommandRegistry;
let server: RunningServer;
let presentationId: string;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, please run npm run build first");

  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-demo-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-demo-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  registry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "demo.slidra");
  await packDirectory(demoDir, slidraPath);
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

  server = await startServe({ policy: openPolicy, presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  if (slidraHome) await rm(slidraHome, { recursive: true, force: true });
  if (slidraDir) await rm(slidraDir, { recursive: true, force: true });
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

// Every element is a `<g>` container wrapping its primitives, and
// the `id` lives on that container (ADR-0008). `textContent` on a container
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

// What an element that is "kept" or "replayed" during a reverse step should
// look like: opacity is exactly 1 (not merely "not 0" — a fade-in mid-animation
// is also not 0), and there is no transition at all. resetToStep()'s replay
// path explicitly forces transition: none and sets opacity to 1 !important
// on every element it touches, so both values are ALREADY true, not
// eventually true; this function deliberately does not poll, since polling
// would let a wrongly-replayed fade-in finish before passing.
async function expectReplayedInstantly(locator: Locator): Promise<void> {
  const computed = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return { opacity: style.opacity, transitionDuration: style.transitionDuration };
  });
  expect(computed).toEqual({ opacity: "1", transitionDuration: "0s" });
}

// App.tsx renders the runtime's reported errors as `.player-error-notice`
// in the *parent* document (not inside the play iframe) — this is what
// "surfaces" means in the acceptance wording. `page.on("pageerror")`
// only catches uncaught exceptions in the page and would never see this
// banner, since the runtime reports errors to the parent over postMessage.
// A fresh renderPlay() on a page change clears the banner, so this must be
// polled after every single reverse key press, not only once at the end.
async function expectNoErrorBanner(page: import("playwright").Page): Promise<void> {
  await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBe(0);
}

// Same reasoning as e2e/player-media.test.ts's waitForPlayerFocus: the
// sandbox attribute is "allow-scripts" in both view and play mode (ADR-0007),
// so it can no longer distinguish "play mode has started" from "still
// viewing". Wait for .titlebar (view mode's shell chrome) to unmount instead,
// which is what actually flips only on entering play. Only once that has
// happened does waiting on the play bar's `data-player-focus` mean anything
// (a later refactor replaced the focus notice this used to wait on with that attribute).
async function waitForPlayerFocus(page: import("playwright").Page): Promise<void> {
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  await expect.poll(() => page.locator('.play-bar[data-player-focus="true"]').count(), { timeout: 10_000 }).toBe(1);
}

it("acceptance deck: one continuous run of forward arrow-key presses through all four pages, then all the way back to page 1's start — page changes, appear, fade-in, video starts playing, audio starts playing, step-by-step reverse, cross-page reverse, all without ever leaving the screen", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");

  await expect
    .poll(() => textOf(playFrame().locator("#el-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Acceptance Demo Deck");

  await page.locator('.play-button').click();
  await waitForPlayerFocus(page);

  // Page 1 has no effects, so one arrow-key press moves straight to page 2.
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => textOf(playFrame().locator("#el-asset-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 2: assets");

  // Page 2 also has no effects, so another press moves straight to page 3 (the effect list page).
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => textOf(playFrame().locator("#el-effects-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 3: effect list");
  await waitForPlayerFocus(page);

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

  // Page 3 is done, so another press moves to page 4 (the media page).
  await waitForPlayerFocus(page);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 4: audio/video");
  // A page change is a srcdoc reload (ADR-0007): the runtime has to
  // complete the ready handshake again before hiding is applied, and before
  // the keyboard listener is remounted.
  await waitForPlayerFocus(page);

  const caption = playFrame().locator("#el-media-caption");
  await expectHidden(caption);

  // Fade-in.
  await page.keyboard.press("ArrowRight");
  await expectVisible(caption);

  // The video starts playing: it aligns with the placeholder element, and is really decoding and really advancing, not just play() resolving.
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

  // The audio starts playing: playing at the same time as the video, again checked by currentTime really advancing.
  await page.keyboard.press("ArrowRight");
  const audio = playFrame().locator("audio");
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState), { timeout: 10_000 }).toBeGreaterThan(0);
  const audioT0 = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(audioT0);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);

  // The video is still playing — advancing to the audio step does not stop
  // the earlier media. The runtime's convergence of video state is
  // asynchronous: under heavy machine load, reading `paused` synchronously
  // right after the action can land before convergence finishes and
  // intermittently fail. Poll until a truly settled terminating condition instead.
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.paused), { timeout: 10_000 })
    .toBe(false);

  // Already at the last step of the whole deck: pressing again is a no-op, no crash.
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null))
    .toBe("Page 4: audio/video");

  // --- Reverse walk: the acceptance criterion for this is the mirror of the
  // forward walk above — from page 4's last step, pressing the left arrow
  // key all the way back to page 1's start, never leaving the screen, no
  // audio, no errors. Continuing directly from the forward-walk state
  // (still on page 4, video and audio both playing) rather than opening a
  // fresh `it` and walking forward again: this way the reverse walk verifies
  // it continues from `currentStep`'s state rather than starting over, and
  // keeps this file as one continuous, readable acceptance story.

  // Set up the error-banner observer BEFORE the reverse walk starts.
  // expectNoErrorBanner's expect.poll(...).toBe(0) returns as soon as it
  // reads 0, without watching for the full timeout; the runtime reports
  // errors back to the parent via postMessage (arriving on the next task),
  // and the next page change re-runs renderPlay and clears the banner — a
  // banner that really did surface could easily be missed by this kind of
  // polling. A MutationObserver is the opposite: it records every
  // occurrence, and after the walk we check once that the record is empty.
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
      // Also sweep the current DOM once: a banner node that already exists,
      // with only its text rewritten, would never show up in addedNodes.
      // Recording it twice doesn't matter — the only assertion at the end is
      // that this record is empty.
      collect(document.body);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const recordedErrorBanners = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __errorBanners: string[] }).__errorBanners);

  // Grab the element handles for the currently-playing video/audio before
  // the reverse walk starts. On a reverse step the runtime removes the
  // overlay elements from the document entirely, after which the locator's
  // count becomes 0 — but "not in the DOM" does not mean "no sound": a
  // media element that has already left the document can still be making
  // sound, with count still 0, and the test would pass regardless. Holding
  // the handle lets us ask the element itself about `paused`.
  // Verified locally (Chromium 151): simply "removed without calling
  // pause()" isn't caught, because the HTML spec requires the browser to
  // auto-pause a media element once it reaches a stable state after leaving
  // the document; but if any code calls play() on that already-detached
  // element after that auto-pause, paused stays false forever — only the
  // two lines below would catch that, with count still 0.
  const videoHandle = await video.elementHandle();
  const audioHandle = await audio.elementHandle();
  if (!videoHandle || !audioHandle) throw new Error("expected a playing video and audio before the reverse walk starts");

  // Step back once: only back to page 4's "fade-in" step, still on page 4,
  // not a full page change. This is the step where a still-loading media
  // element gets torn down, and where the AbortError-suppression path runs,
  // so the error-banner check must start from this step, not only at the end.
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 4: audio/video");
  await expectVisible(caption);
  // A step-back replay does not replay media (an intentional design
  // decision): the video/audio overlay elements are torn down entirely, not
  // paused — there is no leftover playing media.
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);
  // The two counts above only prove the nodes are not in the document. The
  // next two lines are what actually prove "no sound": asking the two
  // already-removed elements themselves about `paused`. They prove different things, both worth keeping.
  expect(await videoHandle.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  expect(await audioHandle.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);

  // Step back again: back to page 4's first step (the caption fade-in step itself), still on page 4.
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-media-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 4: audio/video");
  await expectVisible(caption);
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);

  // Page 4 has already retreated to its first step; one more step crosses
  // pages back to page 3, which should render as "the whole page already
  // played through" — all three steps already applied, not its opening state.
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-effects-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 3: effect list");
  await waitForPlayerFocus(page);
  const stepOneBack = playFrame().locator("#el-step-one");
  const stepTwoBack = playFrame().locator("#el-step-two");
  const stepThreeBack = playFrame().locator("#el-step-three");
  await expectVisible(stepOneBack);
  await expectVisible(stepTwoBack);
  await expectVisible(stepThreeBack);

  // expectVisible only proves opacity isn't "0" — a fade-in animation
  // mid-flight would also pass it. A cross-page reverse replay must be
  // "already finished, and never actually animated": the runtime synchronously
  // runs resetToStep(startStep) (player-runtime.js's startStep block) before
  // posting "ready", and waitForPlayerFocus above only returns once the ready
  // handshake completes, so the computed style read here is already the
  // replay's final state — no polling needed.
  await expectReplayedInstantly(stepOneBack);
  await expectReplayedInstantly(stepTwoBack);
  await expectReplayedInstantly(stepThreeBack);

  // The key assertion for "only one step back": one reverse step only hides
  // the third line, leaving the first two still visible.
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expectVisible(stepOneBack);
  await expectVisible(stepTwoBack);
  await expectHidden(stepThreeBack);

  // expectHidden above polls until opacity reaches 0 — even if this step
  // wrongly played a fade-out animation, polling would just wait for the
  // animation to finish and still pass, which doesn't prove "disappeared
  // instantly." Here we read the browser's computed style directly, without
  // polling: resetToStep()'s documented behavior forces transition to "none"
  // and opacity straight to 0, and both must be ALREADY true, not eventually
  // true. This is exactly what a jsdom-based state test can't see — only a
  // real browser can.
  expect(await stepThreeBack.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  expect(await stepThreeBack.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");

  // The two remaining lines likewise must ALREADY be in their final state.
  // expectVisible only requires opacity !== "0", which a reverse step that
  // wrongly replayed a fade-in would pass mid-animation; here we skip
  // polling and read the computed style directly, requiring opacity to be
  // exactly "1" with no transition at all. The expectHidden call above has
  // already proven this round of resetToStep() (which runs synchronously)
  // has finished, so what's read here is the final value.
  await expectReplayedInstantly(stepOneBack);
  await expectReplayedInstantly(stepTwoBack);

  // One more step back: only the first line is left visible.
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expectVisible(stepOneBack);
  await expectHidden(stepTwoBack);

  // Page 3 has retreated to its start; one more step crosses back to page 2
  // (which has no effects, so "played through" looks the same as its normal
  // state).
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-asset-title")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 2: assets");
  await waitForPlayerFocus(page);

  // Page 2 has no effect steps at all: one press crosses straight back to page 1.
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-subtitle")).catch(() => null), { timeout: 30_000 })
    .toBe("Page 1: paging, live preview");
  await waitForPlayerFocus(page);

  // Already at the very beginning of the whole deck: pressing again is a no-op, no crash.
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-subtitle")).catch(() => null))
    .toBe("Page 1: paging, live preview");
  await page.keyboard.press("ArrowLeft");
  await expectNoErrorBanner(page);
  await expect
    .poll(() => textOf(playFrame().locator("#el-subtitle")).catch(() => null))
    .toBe("Page 1: paging, live preview");

  // No error ever surfaced across the whole run, and no media is still playing.
  expect(pageErrors).toEqual([]);
  // Across the entire reverse walk, the error banner never appeared once —
  // including ones that appeared and were then cleared by the next page
  // change before any single poll could see them. This is the real evidence
  // for "no error surfaced."
  expect(await recordedErrorBanners()).toEqual([]);
  await expect.poll(() => video.count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => audio.count(), { timeout: 10_000 }).toBe(0);
  // We don't ask videoHandle / audioHandle about paused again here: the
  // reverse walk has already crossed pages away from page 4, and that
  // srcdoc document, along with its whole JS execution context, has been
  // swapped out (the handle would just throw "Execution context was
  // destroyed") — the element itself can no longer possibly be making
  // sound. The "removed without pause" defect would already have been
  // caught at the earlier same-page reverse step, while that document was
  // still alive.
});

/**
 * Opening a converted slide directly in the browser: no Slidra, no server, no
 * injected runtime — just `file://` and the browser's own SVG renderer.
 * This is the check that the container form is plain, native SVG and not
 * something only Slidra knows how to draw.
 */
it("a converted slide opened directly via file:// renders correctly: text, position, and relative-path images all check out", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    const failedRequests: string[] = [];
    page.on("requestfailed", (request) => failedRequests.push(request.url()));
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));

    await page.goto(`file://${path.join(demoDir, "slides/001.svg")}`);

    // The id resolves to the element, and the element carries the text.
    expect((await page.locator("#el-title").textContent())?.trim()).toBe("Acceptance Demo Deck");
    expect((await page.locator("#el-subtitle").textContent())?.trim()).toBe("Page 1: paging, live preview");

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
    // the appearance baselines have (see AGENTS.md's visual-regression gatekeeping section). A few
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
 * The converted slide's pixels are pixel-identical to the original — the direct form of the evidence.
 *
 * The five committed baseline screenshots (appearance/stage/grid/play/
 * selection) already watch `demo/` from outside this unit's write boundary,
 * which is what makes them honest. This test proves the same property about
 * conversion itself rather than about one particular deck: it renders a
 * hand-written BARE slide and its own converted output in the same browser,
 * at the same viewport, and compares the two PNGs byte for byte. No new
 * baseline PNG is committed — the two shots are each other's baseline.
 */
it("the same slide, before and after conversion, renders pixel-identical in the browser", async () => {
  const bare =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
    '  <rect x="0" y="0" width="1280" height="720" fill="#101418"/>\n' +
    '  <text id="el-title" data-slidra-name="Title" x="640" y="200" text-anchor="middle" font-size="86" fill="#f4f6f8">Before/after conversion</text>\n' +
    '  <image id="el-photo" href="assets/photo.svg" x="490" y="260" width="300" height="300"/>\n' +
    '  <line x1="100" y1="620" x2="1180" y2="620" stroke="#c66" stroke-width="6"/>\n' +
    '  <path d="M100 660 L200 700 L100 700 Z" fill="#9aa7b4"/>\n' +
    '  <g id="el-icon" data-slidra-name="Icon">\n' +
    '    <circle cx="1100" cy="670" r="30" fill="#c66"/>\n' +
    '  </g>\n' +
    "</svg>\n";

  const dir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-pixel-"));
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    // `normaliseSlideSvg`/`generateElementId` (the TypeScript engine's own
    // conversion functions) no longer exist — the only public
    // door to the same conversion is now `slidra convert`, which acts on
    // an already-open presentation's slide file on disk, not a raw string.
    // A throwaway presentation under the same `registry`/`SLIDRA_HOME`
    // this file's `beforeAll` already set up (never the shared 4-page demo
    // presentation the walkthrough tests below depend on) gives `convert`
    // something to act on: write `bare` as its `slides/001.svg`, run
    // `convert`, read the result back.
    const sourceDir = path.join(dir, "source");
    await mkdir(path.join(sourceDir, "slides"), { recursive: true });
    await writeFile(
      path.join(sourceDir, "project.json"),
      JSON.stringify({ formatVersion: 1, name: "Before/after conversion pixel comparison", canvas: { width: 1280, height: 720 }, slides: ["slides/001.svg"] }),
    );
    await writeFile(path.join(sourceDir, "slides/001.svg"), bare);
    const convertSlidraPath = path.join(dir, "convert-test.slidra");
    await packDirectory(sourceDir, convertSlidraPath);
    const opened = await registry.dispatch<{ id: string }>("open", { path: convertSlidraPath });
    const convertTestId = opened.data!.id;
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

/** Reads the RGB of the pixel at an element's own rendered center, from its own `.screenshot()` (never the surrounding page — that would also catch the `<body>` fallback, out of scope here per canvas.ts's own comment). */
function centerRgb(png: PNG): { r: number; g: number; b: number } {
  const x = Math.floor(png.width / 2);
  const y = Math.floor(png.height / 2);
  const index = (png.width * y + x) << 2;
  return { r: png.data[index], g: png.data[index + 1], b: png.data[index + 2] };
}

/**
 * The demo's four pages' root `<svg>` `background-color` replaces
 * what used to be a full-viewport `<rect>` (a prior commit). This test is
 * the behavioral contract for four actual rendering paths (the edit stage,
 * the left-rail thumbnail, playback, and export) — each path must paint
 * this declaration as a visible background color inside its own wrapper
 * document, not merely rely on `slide style set` being able to write the attribute.
 *
 * Every measurement point uses the element's own `.screenshot()` (never a
 * full-page screenshot): canvas.ts's three wrapper documents have a white
 * `<body>` background (the fallback color), and when the container box
 * is taller than the svg box a white edge shows at the bottom (a separate,
 * unrelated issue). Cropping to just the svg's own box never runs into that
 * white edge, so what this test actually verifies is "the svg box itself
 * paints the configured color", not "the whole iframe has no white pixels".
 */
it("the demo's four pages' background color is decided by the root <svg>'s background-color: the edit stage / left-rail thumbnail / playback / export paths all measure #101418, not white", async () => {
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

  const outPath = path.join(slidraDir, "background-check.pdf");
  await execFileAsync(slidraBin, ["export", presentationId, "--format", "pdf", "--out", outPath], {
    env: { ...process.env, SLIDRA_HOME: slidraHome, SLIDRA_BIN: slidraBin },
  });
  const pdfBytes = await readFile(outPath);
  const info = await loadPdf(browser, pdfBytes);
  try {
    const { r, g, b } = centerRgb(PNG.sync.read(await info.rasterizePage(0)));
    // Export goes through one round of PDF rasterization, so allow ±2 per
    // channel of floating-point error (the same tolerance e2e/export-cli.test.ts's
    // existing rasterization comparisons already use).
    expect(Math.abs(r - 16)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 24)).toBeLessThanOrEqual(2);
  } finally {
    await info.close();
  }
}, 60_000);
