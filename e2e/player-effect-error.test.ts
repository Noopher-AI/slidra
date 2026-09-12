import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * The spec states: "when an unimplemented family, effect, or start mode is
 * encountered, throw and explain it on screen — don't silently ignore it."
 * Nothing in the repo tested the DOM
 * side of that sentence — apps/web/src/canvas.ts throws and surfaces
 * `error` (unit-tested indirectly through effects.ts/player-plan.ts), but
 * whether an author actually SEES a message, with enough detail to find
 * the broken line, was never checked end to end. This file closes that
 * gap with a hand-written broken fixture
 * (`e2e/fixtures/broken-effects-deck/`): five slides, five different
 * kinds of damage —
 *   1. a `family="media"` effect target missing `data-slidra-media` (the
 *      exact mistake made while hand-authoring `demo/slides/004.svg`)
 *   2. a `target` that does not resolve to any element on the slide (a
 *      very plausible typo: an id renamed without updating the effect
 *      list that points at it)
 *   3. an unimplemented `family` value (`build` — `emphasis` was
 *      implemented for real, so this fixture's stand-in for "a family
 *      nothing implements" moved to a value that stays permanently
 *      unimplemented)
 *   4. an unimplemented `effect` value under an otherwise-valid family
 *      (`enter`/`wipe` — plausible if an author assumes PowerPoint-style
 *      transition names just work; `wipe` is deliberately never
 *      implemented — this fixture is *why* it never will be)
 *   5. an unimplemented `start` value (`on-hover` — `with-previous` was
 *      implemented for real, so this fixture's stand-in for "a start
 *      nothing implements" moved to a value that stays permanently
 *      unimplemented)
 * An earlier review pass found #3–#5 missing: the suite only proved the DOM banner exists for damage it happens to
 * be good at catching, not for the "unimplemented" half of the spec
 * sentence — exactly the gap this kind of e2e test exists to close.
 *
 * Two things this test insists on:
 *   1. The banner text must name the actual broken thing (element id /
 *      attribute name / unsupported value), not just say "something went
 *      wrong" — otherwise "explain it" is not satisfied, only "throw" is.
 *   2. The degraded slide must still render its real content (canvas.ts's
 *      renderPlay catch branch falls back to wrapSlideDocument — the
 *      static, no-runtime render used in view mode) rather than leaving
 *      the frame blank.
 *
 * Every `page.close()` below was diagnosed this way: with timestamped
 * observation added, the file was run repeatedly around 30 times, and
 * roughly 1 in every 5-8 runs hung all the way to the 120-second test
 * timeout. The sticking point was that when some `it()` called `cleanup()`
 * (-> `server.close()`), that test's own page still had its live-reload/chat
 * SSE connection open (opened eagerly on mount — see App.tsx). `startServe`'s
 * `close()` does actively close the streams it tracks itself, but like any
 * ordinary `http.Server.close()`, it still waits for other connections still
 * open on the socket; an unclosed Playwright page's connection only dies
 * once the shared `browser` in `afterAll` fully closes, at which point every
 * stuck `server.close()` resolves at once — exactly what the timestamped
 * observation showed.
 *
 * The root cause was later fixed in a follow-up:
 * `packages/server/src/serve.ts`'s `close()` now calls
 * `server.closeAllConnections()` right after `server.close(cb)`, so closing
 * no longer hangs even with connections still open. This was actually
 * measured against this file: with every `page.close()` below removed,
 * running this file 10 times in a row passed every time with no hang (each
 * run took about 2 seconds, far from the 120-second timeout that bites).
 * 10 runs is a small sample against a bug that originally hit roughly 1 in
 * 5-8 times, so this only shows "it didn't reproduce in this sample", not
 * that the hang can never happen again.
 *
 * This was also run as a control: the same file with `page.close()` removed,
 * against the old `serve.ts` before the fix (no `closeAllConnections()`), on
 * the same machine and Node version. It hung all the way to the 120-second
 * timeout on the 3rd run — 1 test failed, 3 passed — meaning the hang still
 * reproduces on this machine and this Node version, it isn't a case of "this
 * machine just happens not to reproduce it right now." So the 10 clean runs
 * above were measured against a failure mode that genuinely still occurs,
 * not simply an absence of observed failure.
 *
 * Even so, `page.close()` is deliberately kept here: closing the page is
 * good hygiene regardless of whether the server side is fixed, and keeping
 * it means that if `close()` ever regresses again, it turns into a clearly
 * attributable failure here instead of a mysterious 120-second timeout.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/broken-effects-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist does not exist, run npm run build first");

  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

async function startServerFor(): Promise<{
  server: RunningServer;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-effecterror-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-effecterror-files-"));
  process.env["SLIDRA_HOME"] = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env["SLIDRA_BIN"] = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "broken-effects-deck.slidra");
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
    presentationId,
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

it("effect list parsing fails on entering play: an error notice on screen names where the problem is, and the slide still renders its original content statically", async () => {
  const { server, cleanup } = await startServerFor();
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    // View mode: computePlayerPlan is never called, so slide 1 is completely
    // normal here and its content is visible — only the effect list is
    // broken, not the slide itself.
    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 1: missing data-slidra-media");

    await page.locator('.play-button').click();

    // Entering play: effects.ts throws parsing slide 1's effect list (the
    // media effect's target is missing data-slidra-media), and canvas.ts
    // shows it as an on-screen banner.
    const notice = page.locator(".player-error-notice");
    await expect.poll(() => notice.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    const noticeText = await notice.first().textContent();
    // The message must name which element and which attribute is missing —
    // not an empty phrase like "an error occurred" — so the author can
    // actually find the line to fix.
    expect(noticeText).toContain("el-speaker");
    expect(noticeText).toContain("data-slidra-media");

    // The degraded behavior must be honest: a parse failure is not the same
    // as a blank screen — the slide's own content is still there.
    const opacityOf = (selector: string) =>
      playFrame()
        .locator(selector)
        .evaluate((el) => getComputedStyle(el).opacity)
        .catch(() => null);
    await expect.poll(() => opacityOf("#el-broken-title")).toBe("1");
    await expect.poll(() => opacityOf("#el-speaker")).toBe("1");

    // Switch to slide 2 (a different kind of damage: target points to an
    // element that doesn't exist). Arrow-key advancement in play mode has no
    // runtime to listen for it once parsing has failed, so this uses the
    // control bar's "next" instead — it's wired to controller.next() (i.e.
    // showSlide(currentIndex+1), changing the page without changing effect
    // steps), which works in play mode without any runtime alive.
    await page.locator('.play-bar button[aria-label="Next"]').click();

    await expect
      .poll(() => playFrame().locator("#el-broken-title-2").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 2: target points to a nonexistent element");

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
    // an intermittent ~1-in-5 full-120s hang in this exact file —
    // closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});

it("an unimplemented family on entering play: an error notice on screen names that family value", async () => {
  const { server, cleanup } = await startServerFor();
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 1: missing data-slidra-media");

    await page.locator('.play-button').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // Switching from slide 1 to slide 3: the control bar's "next" changes
    // the page by ±1, not by jumping, so click it twice, passing through
    // slide 2 (a different kind of damage, see the previous test).
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-3").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 3: unimplemented family");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("build");
    expect(noticeText).toContain("not yet implemented");

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
    // an intermittent ~1-in-5 full-120s hang in this exact file —
    // closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});

it("an unimplemented effect on entering play: an error notice on screen names that effect value", async () => {
  const { server, cleanup } = await startServerFor();
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 1: missing data-slidra-media");

    await page.locator('.play-button').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // Switching from slide 1 to slide 4: click "next" three times (see the previous test's explanation).
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-4").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 4: unimplemented effect");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("wipe");
    expect(noticeText).toContain("not yet implemented");

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
    // an intermittent ~1-in-5 full-120s hang in this exact file —
    // closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});

it("an unimplemented start on entering play: an error notice on screen names that start value", async () => {
  const { server, cleanup } = await startServerFor();
  let page: import("playwright").Page | undefined;
  try {
    page = await browser.newPage();
    await page.goto(server.url);

    const playFrame = () => page.frameLocator("iframe.slide-frame");

    await expect
      .poll(() => playFrame().locator("#el-broken-title").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 1: missing data-slidra-media");

    await page.locator('.play-button').click();
    await expect.poll(() => page.locator(".player-error-notice").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // Switching from slide 1 to slide 5: click "next" four times (see the previous test's explanation).
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await page.locator('.play-bar button[aria-label="Next"]').click();
    await expect
      .poll(() => playFrame().locator("#el-broken-title-5").textContent().catch(() => null), { timeout: 30_000 })
      .toBe("Slide 5: unimplemented start");

    const noticeText = await page.locator(".player-error-notice").first().textContent();
    expect(noticeText).toContain("on-hover");
    expect(noticeText).toContain("not yet implemented");

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
    // an intermittent ~1-in-5 full-120s hang in this exact file —
    // closing the page here made 16/16 repeated runs
    // pass cleanly where the un-fixed version reproduced the hang twice
    // in 16 runs.
    await page?.close();
    await cleanup();
  }
});
