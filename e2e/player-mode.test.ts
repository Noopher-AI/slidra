// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Play mode end to end: entering play, stepping through effects
 * with the keyboard, advancing past a slide's last step, leaving play, and
 * the two static-safety guarantees the spec requires (a slide
 * opened directly in a browser shows every element; the underlying file's
 * bytes never change across a play session). The hand-written fixture is
 * `fixtures/play-deck/` — real effect lists, real steps, nothing generated.
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

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-playmode-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-playmode-files-"));
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

it("full play path: entering play, stepping through effects, changing pages, exiting play, and the slide files' bytes never change", async () => {
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

  await expect.poll(() => bgText.textContent().catch(() => null), { timeout: 30_000 }).toBe("Play Slide 1");

  // An element that belongs to no step is already on screen the moment its page is entered.
  await expectVisible(bgText);

  // Before entering play: neither enter element has been hidden by the
  // runtime yet (that's play-exclusive); in view mode a slide is its own
  // static, final appearance (ADR-0006).
  await expectVisible(fadeText);

  await page.locator('.play-button').click();

  // The play-mode iframe carries allow-scripts, not allow-same-origin.
  const sandbox = await page.locator("iframe.slide-frame").getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");

  // Entering play never flashes full content: both enter elements must be
  // invisible immediately on entry.
  await expectHidden(fadeText);
  await expectHidden(appearText);
  // An element that belongs to no step stays on screen when entering play.
  await expectVisible(bgText);

  // Entering play hands focus to the player: arrow keys can advance immediately, no click needed first.
  await page.keyboard.press("ArrowRight");
  await expectVisible(fadeText, 10_000);
  await expectHidden(appearText);

  await page.keyboard.press("ArrowRight");
  await expectVisible(appearText, 10_000);

  // Press once more at the last step, changing to the next page.
  await page.keyboard.press("ArrowRight");
  const secondTitle = playFrame().locator("#el-title2");
  await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 30_000 }).toBe("Play Slide 2");
  const secondFade = playFrame().locator("#el-second-fade");
  await expectHidden(secondFade);

  await page.keyboard.press("ArrowRight");
  await expectVisible(secondFade, 10_000);

  // Already at the last step of the entire deck: pressing once more does nothing and doesn't crash.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondTitle.textContent().catch(() => null)).toBe("Play Slide 2");

  // Currently on slide 2's only step (el-second-fade), with no earlier step
  // to retreat to: ArrowLeft triggers retreat-past-start, switching back to
  // slide 1, which is presented as "the whole page already ran" — both
  // steps (fade, appear) already applied, not reset to its start.
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => bgText.textContent().catch(() => null), { timeout: 30_000 }).toBe("Play Slide 1");
  await expectVisible(fadeText);
  await expectVisible(appearText);

  // Exit play mode, back to view.
  await page.locator('button:has-text("Exit Play")').click();
  // ADR-0007: view mode now runs a script too (selection-runtime.js), so
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

it("when focus is stolen out of the player, arrow keys still advance without needing to fix focus first", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect.poll(() => fadeText.textContent().catch(() => null), { timeout: 30_000 }).toBe("Fade-in text");

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
  // focus back on its own, so Tab is not a stand-in for some other trigger
  // — it *is* the trigger, and it is a keyboard one, which is what made the
  // old "click this notice" answer unusable.
  await page.keyboard.press("Tab");
  await expect.poll(() => playBar.getAttribute("data-player-focus"), { timeout: 10_000 }).toBe("false");

  // The key press still lands even with focus outside the player. The parent document sees
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

it("while the player holds focus, one arrow-key press only advances one step — the parent document does not race the runtime to react", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const playFrame = () => page.frameLocator("iframe.slide-frame");
  const fadeText = playFrame().locator("#el-fade-in");
  const appearText = playFrame().locator("#el-appear-in");

  await expect.poll(() => fadeText.textContent().catch(() => null), { timeout: 30_000 }).toBe("Fade-in text");

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

// Transitions are always set in tests via `slide transition set`, never by
// touching fixtures/play-deck/ itself — this also proves the CLI path
// really matches what happens during play.
it("leaving a slide plays its exit transition before genuinely changing the page (advancing); retreating cuts instantly, with no exit played", async () => {
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

    // Advance through slide 1's two steps.
    await page.keyboard.press("ArrowRight");
    await expectVisible(fadeText, 10_000);
    await page.keyboard.press("ArrowRight");
    await expectVisible(appearText, 10_000);

    // Third press -> triggers advancing to the next page: the departing slide (slide 1) plays exit first.
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => frame.evaluate((el) => (el as HTMLElement).style.opacity), { timeout: 5_000 }).toBe("0");
    // Exit hasn't finished playing yet, so it's still slide 1's content.
    expect(await playFrame().locator("#el-title").count()).toBeGreaterThan(0);

    // Only once exit finishes does it genuinely switch to slide 2.
    await expect.poll(() => secondTitle.textContent().catch(() => null), { timeout: 10_000 }).toBe("Play Slide 2");
    await expect.poll(() => frame.evaluate((el) => (el as HTMLElement).style.opacity), { timeout: 5_000 }).not.toBe("0");

    // Retreating back to slide 1: retreatPastStart() never calls
    // playExitTransition() — unlike advancing, there's no asynchronous
    // in-between window to poll for here, so this can be asserted right at
    // the moment of the key press.
    await page.keyboard.press("ArrowLeft");
    expect(await frame.evaluate((el) => (el as HTMLElement).style.opacity)).not.toBe("0");
    await expect
      .poll(() => playFrame().locator("#el-title").textContent().catch(() => null), { timeout: 10_000 })
      .toBe("Play Slide 1");
  } finally {
    await registry.dispatch("slide transition set", {
      id: presentationId,
      slidePath: "slides/001.svg",
      exit: "none",
      exitDuration: 0.5,
    });
  }
});

it("Space, PageDown, and clicking the screen all advance one effect step; PageUp retreats one", async () => {
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
    if (!box) throw new Error("could not find .play-mousemove-catcher's bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expectVisible(fadeText, 10_000);
    await expectHidden(appearText);
    await page.close();
  }

  {
    // PageUp retreats one step — same premise as the existing ArrowLeft
    // test: it must first be standing on step 2 (currentStep >= 1), so
    // retreating one step genuinely changes the screen instead of sending
    // retreat-past-start (which is the existing behavior for "already at
    // step 1", unrelated to PageUp itself — see player-runtime.test.ts's
    // matching test).
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

it("pressing Esc in play mode (focus inside the player) returns to edit mode: .titlebar reappears, iframe sandbox goes back to allow-scripts", async () => {
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.locator(".play-button").click();
  await expect
    .poll(() => page.locator(".play-bar").getAttribute("data-player-focus"), { timeout: 10_000 })
    .toBe("true");
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);
  // AC6②: <Rail> — and the user block mounted inside it — is unmounted entirely in play mode, same as .titlebar above.
  await expect.poll(() => page.locator(".user-block").count()).toBe(0);

  // Focus is inside the play iframe here — this Esc is caught by
  // player-runtime.js's own keydown handler, which posts an "exit-play"
  // message to the parent document. That's a different path from the
  // parent document's own Escape listener (the one used when focus is
  // outside), but both should lead to the same result.
  await page.keyboard.press("Escape");

  await expect.poll(() => page.locator(".titlebar").count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => page.locator(".user-block").count()).toBe(1);
  await expect.poll(() => page.locator("iframe.slide-frame").getAttribute("sandbox")).toBe("allow-scripts");
});

it("opening a single slide file directly in a browser shows every element, including ones that only appear during play", async () => {
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
