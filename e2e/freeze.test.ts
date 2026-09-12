import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Ctrl+Z's granularity and the editing freeze, driven in a real browser
 * against a real server. Server-side grouping/freeze-window behaviour is
 * covered exhaustively over HTTP in packages/server/test/agent/freeze.test.ts
 * — this file only exercises what needs an actual browser: "frozen still
 * browses" and the Ctrl+Z keyboard path.
 *
 * The agent is `editing-fake-acp-agent.mjs`, the same fixture
 * e2e/smoke.test.ts and e2e/player.test.ts already use, given
 * `E2E_FREEZE_HOLD_MS` so the freeze window is long enough to reliably
 * assert against in a real browser instead of racing a turn that would
 * otherwise complete within a couple of event-loop ticks.
 *
 * Each test gets its own fresh presentation and server (modeled on
 * e2e/selection.test.ts's startServerFor) — sharing one across tests would
 * let one test's undo/title state leak into the next.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/player-deck");
// player-deck has no draggable element (see this file's own header comment
// on e2e/direct-manipulation.test.ts's fixture) — the drag-related tests below
// need a deck with both a draggable element AND a `<text id=...>` the fake
// agent can `text set`, so they reuse direct-manipulation's fixture/font-injection
// shape instead (startServerForDrag/openAppDrag below).
const dmDeckDir = path.join(e2eDir, "fixtures/direct-manipulation-deck");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const NEW_TITLE = "凍結測試改過的標題";
const FREEZE_HOLD_MS = 1500;
const DM_VIEWPORT = { width: 1440, height: 900 };
const DM_VIEWBOX = { width: 1280, height: 720 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
  console.log(`瀏覽器：Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

async function startServerFor(): Promise<{ server: RunningServer; cleanup: () => Promise<void> }> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-freeze-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-freeze-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "player-deck.slidra");
  await packDirectory(deckFixtureDir, slidraPath);
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
      E2E_NEW_TITLE: NEW_TITLE,
      E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS),
    },
  };

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer): Promise<{ page: Page; pageErrors: string[] }> {
  const page = await browser.newPage();
  openPages.push(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(server.url);
  return { page, pageErrors };
}

function currentSlideTextOf(page: Page, pageErrors: string[]): () => Promise<string | null> {
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  return async () => {
    if (pageErrors.length > 0) return `頁面錯誤：${pageErrors.join("; ")}`;
    return slideText.textContent().catch(() => null);
  };
}

async function editingFrozen(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const response = await fetch("/api/editing");
    const data = (await response.json()) as { frozen: boolean };
    return data.frozen;
  });
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
  await page.locator(".chat-input textarea").fill(text);
  await page.locator(".chat-input button").click();
}

/**
 * Sends the author's message straight through `POST /api/chat` (the exact
 * endpoint the chat UI itself calls, App.tsx:521) instead of driving the
 * `.chat-input` UI. The test below needs to fire this while a real mouse button is
 * physically held down mid-drag (`dragBy`'s `onMidDrag`) — clicking the
 * chat button there would move the mouse away from the iframe and off the
 * gesture in progress, corrupting the very drag the test means to observe.
 * `POST /api/chat` is a real, public HTTP boundary, not a mock.
 */
async function sendChatMessageViaApi(page: Page, text: string): Promise<void> {
  await page.evaluate(async (message) => {
    await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  }, text);
}

/**
 * player-deck-shaped `startServerFor`, but packing
 * `fixtures/direct-manipulation-deck` (draggable elements + a `<text
 * id="el-caption-text">` the fake agent can `text set`) with the real
 * embedded-font bytes injected the same way e2e/direct-manipulation.test.ts
 * does — that file's own header comment explains why the checked-in fixture
 * doesn't carry the font file itself. Also returns `registry`/
 * `presentationId` so a test can read the packed file's actual bytes
 * (`readSlide` below), the same real-file assertion direct-manipulation's
 * own tests use.
 */
async function startServerForDrag(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-freeze-dm-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-freeze-dm-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-freeze-dm-deck-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  await cp(dmDeckDir, deckStagingDir, { recursive: true });
  await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
  await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckStagingDir, slidraPath);
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
      E2E_NEW_TITLE: NEW_TITLE,
      E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS),
    },
  };

  const server = await startServe({ presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
      await rm(deckStagingDir, { recursive: true, force: true });
    },
  };
}

async function openAppDrag(server: RunningServer): Promise<{ page: Page; pageErrors: string[] }> {
  const page = await browser.newPage({ viewport: DM_VIEWPORT });
  openPages.push(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return { page, pageErrors };
}

/** The main-canvas `<svg>`'s bounding box in PAGE (viewport) coordinates — what `page.mouse` expects. (Not worth extracting into a shared cross-file helper.) */
async function svgBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const svg = page.frameLocator("iframe.slide-frame").locator("svg").first();
  const box = await svg.boundingBox();
  if (!box) throw new Error("量不到主畫布 svg 的邊界框");
  return box;
}

/** Converts a point in the fixture's own user-unit space (viewBox 0 0 1280 720) to a page-viewport point. */
function toPagePoint(box: { x: number; y: number; width: number; height: number }, userX: number, userY: number) {
  return { x: box.x + (userX / DM_VIEWBOX.width) * box.width, y: box.y + (userY / DM_VIEWBOX.height) * box.height };
}

interface DragOptions {
  /** Called with the page still mid-drag (button down, before mouseup) — for reading the live preview or firing another request while the human lease is held. */
  onMidDrag?: () => Promise<void>;
}

async function dragBy(
  page: Page,
  fromUser: { x: number; y: number },
  deltaUser: { x: number; y: number },
  options: DragOptions = {},
): Promise<void> {
  const box = await svgBox(page);
  const from = toPagePoint(box, fromUser.x, fromUser.y);
  const to = toPagePoint(box, fromUser.x + deltaUser.x, fromUser.y + deltaUser.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  // Let the rAF-throttled gesture-move postMessage land before continuing.
  await page.waitForTimeout(80);
  if (options.onMidDrag) await options.onMidDrag();
  await page.mouse.up();
  // POST /api/command round trip + the file write it causes.
  await page.waitForTimeout(150);
}

/** `translate(x y)` -> `{x, y}`. Throws if the element carries no such transform. */
function readTranslate(svg: string, elementId: string): { x: number; y: number } {
  const elementMatch = new RegExp(`<g id="${elementId}"[^>]*transform="([^"]*)"`).exec(svg);
  if (!elementMatch) throw new Error(`找不到 ${elementId} 的 transform`);
  const translateMatch = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(elementMatch[1]);
  if (!translateMatch) throw new Error(`${elementId} 的 transform 沒有 translate：${elementMatch[1]}`);
  return { x: Number(translateMatch[1]), y: Number(translateMatch[2]) };
}

async function readSlide(registry: CommandRegistry, presentationId: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
  if (!result.ok) throw new Error(result.message);
  return result.data!.content;
}

it("can still navigate slides and enter/exit play mode while frozen; the title has actually updated once unfrozen", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const { page, pageErrors } = await openApp(server);
    const currentSlideText = currentSlideTextOf(page, pageErrors);
    const nextButton = page.locator('.slide-nav-button[aria-label="Next slide"]');
    const previousButton = page.locator('.slide-nav-button[aria-label="Previous slide"]');

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    await sendChatMessage(page, "改標題");
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(true);

    // Navigating slides: freezing doesn't block browsing.
    await nextButton.click();
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第二頁");
    expect(await editingFrozen(page)).toBe(true);

    await previousButton.click();
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    // Entering play mode: freezing doesn't block browsing.
    await page.locator('.play-button').click();
    await page.locator(".play-bar-position").waitFor({ timeout: 30_000 });
    expect(await editingFrozen(page)).toBe(true);

    // Leave play mode, back to view mode.
    await page.locator(".play-toggle-button.leave").click();
    await page.locator(".play-bar-position").waitFor({ state: "detached", timeout: 30_000 });

    // The agent's turn hasn't ended throughout all this browsing — only now
    // wait for it to finish and confirm the title has actually changed.
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(NEW_TITLE);

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("Ctrl/Cmd+Z works once unfrozen and undoes what the agent's turn just did (granularity mirrors the server tests' multi-command grouping)", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const { page, pageErrors } = await openApp(server);
    const currentSlideText = currentSlideTextOf(page, pageErrors);

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    await sendChatMessage(page, "改標題");
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(NEW_TITLE);
    // The turn is over by now (currentSlideText already observed its final
    // effect), so this Ctrl+Z exercises the ordinary, unfrozen path.
    await expect.poll(() => editingFrozen(page)).toBe(false);

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("a single Ctrl/Cmd+Z undoes every command from an agent's turn: both steps count, and it never stops at the intermediate step", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const { page, pageErrors } = await openApp(server);
    const currentSlideText = currentSlideTextOf(page, pageErrors);

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    await sendChatMessage(page, "兩步");
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(`${NEW_TITLE}（第二步）`);

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");

    // One undo returns all the way to the pre-turn text, never stopping at
    // the intermediate first-command state — the whole turn is one group.
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("editing freezes while the agent is acting, the author can see the frozen state, and Ctrl+Z does nothing while frozen", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const { page, pageErrors } = await openApp(server);
    const currentSlideText = currentSlideTextOf(page, pageErrors);
    const banner = page.locator(".editing-frozen-banner");

    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("第一頁");
    expect(await banner.isVisible()).toBe(false);

    await sendChatMessage(page, "改標題");
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => banner.isVisible()).toBe(true);
    expect(await banner.textContent()).toBe("Agent editing · undo/redo paused");

    // TitleBar has its own frozen badge — a separate element from
    // App.tsx's `.editing-frozen-banner` above, with deliberately different
    // text (no "/redo"); this is the first test to guard that exact string.
    const titlebarBadge = page.locator(".titlebar-frozen-badge");
    await expect.poll(() => titlebarBadge.isVisible()).toBe(true);
    expect(await titlebarBadge.textContent()).toBe("Agent editing · undo paused");

    // Both the Undo and Redo buttons are disabled while frozen.
    const undoButton = page.locator('.titlebar-icon-button[aria-label="Undo"]');
    const redoButton = page.locator('.titlebar-icon-button[aria-label="Redo"]');
    expect(await undoButton.isDisabled()).toBe(true);
    expect(await redoButton.isDisabled()).toBe(true);

    // Even bypassing the browser's native click protection for disabled
    // buttons and calling `.click()` on them directly, the slide text still
    // doesn't change — this is a regression guard, not a redundant check of
    // something the disabled attribute would already block (App.tsx's
    // `runUndoRedo` itself also early-returns when
    // `editingFrozenRef.current` is set).
    await undoButton.evaluate((el: HTMLButtonElement) => el.click());
    await redoButton.evaluate((el: HTMLButtonElement) => el.click());
    expect(await currentSlideText()).toBe("第一頁");

    // The existing keyboard Cmd+Z assertion is kept unchanged —
    // App.tsx's editingFrozenRef early-return: Ctrl+Z while frozen sends no
    // request at all, so the (still first-page) text is untouched.
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");
    expect(await currentSlideText()).toBe("第一頁");

    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);
    await expect.poll(() => banner.isVisible()).toBe(false);
    await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(NEW_TITLE);

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("does not freeze when the agent only reads/thinks without issuing any command: the author can still drag the whole time", async () => {
  const { server, registry, presentationId, cleanup } = await startServerForDrag();
  try {
    const { page, pageErrors } = await openAppDrag(server);
    const before = await readSlide(registry, presentationId);
    expect(readTranslate(before, "el-a")).toEqual({ x: 100, y: 100 });

    await sendChatMessage(page, "只看");

    let sawFrozenDuringDrag = false;
    await dragBy(
      page,
      { x: 180, y: 150 }, // inside el-a (100..260, 100..200)
      { x: 60, y: 40 },
      {
        onMidDrag: async () => {
          sawFrozenDuringDrag = await editingFrozen(page);
        },
      },
    );
    // The "look only" message never calls session/request_permission, so
    // openEditLockOnFirstCommand (session.ts:566) is never reached — the
    // deck must never have frozen, before, during, or after the drag.
    expect(sawFrozenDuringDrag).toBe(false);
    expect(await editingFrozen(page)).toBe(false);
    expect(await page.locator(".editing-frozen-banner").isVisible()).toBe(false);

    const after = await readSlide(registry, presentationId);
    const moved = readTranslate(after, "el-a");
    expect(moved.x).toBeGreaterThan(100);
    expect(moved.y).toBeGreaterThan(100);

    const undo = await registry.dispatch("undo", { id: presentationId });
    expect(undo.ok).toBe(true);
    expect(await readSlide(registry, presentationId)).toBe(before);

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("attempting to drag while frozen: the drag is blocked and the presentation file's bytes stay unchanged", async () => {
  const { server, registry, presentationId, cleanup } = await startServerForDrag();
  try {
    const { page, pageErrors } = await openAppDrag(server);

    await sendChatMessage(page, "改標題");
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(true);

    const duringFreeze = await readSlide(registry, presentationId);
    // POST /api/command 409s while the agent holds the floor (serve.ts's
    // own gate) — endMoveGesture reverts the optimistic preview and never
    // writes, so the file must come back byte-for-byte identical.
    await dragBy(page, { x: 180, y: 150 }, { x: 60, y: 40 });
    expect(await readSlide(registry, presentationId)).toBe(duringFreeze);

    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});

it("when the user is dragging as the agent is about to issue its first command: the agent waits for the drag to end before acting, without throwing", async () => {
  const { server, registry, presentationId, cleanup } = await startServerForDrag();
  try {
    const { page, pageErrors } = await openAppDrag(server);

    let sawFrozenDuringDrag = false;
    await dragBy(
      page,
      { x: 180, y: 150 }, // inside el-a (100..260, 100..200)
      { x: 60, y: 40 },
      {
        onMidDrag: async () => {
          // The mouse button is still down here (gesture-start already fired
          // its `POST /api/editing/begin`) — the author's message arrives
          // while the human lease is held, exactly the race this test covers.
          await sendChatMessageViaApi(page, "改標題");
          // Sample repeatedly rather than once: a single sample landing
          // between two ticks would silently pass even if the wait were
          // broken.
          for (let i = 0; i < 5; i++) {
            sawFrozenDuringDrag = sawFrozenDuringDrag || (await editingFrozen(page));
            await page.waitForTimeout(100);
          }
        },
      },
    );
    // The agent must not have grabbed the lock while the drag was still in
    // progress — this is "without erroring out" in observable terms:
    // nothing about the drag was refused or interrupted.
    expect(sawFrozenDuringDrag).toBe(false);

    // The drag's own `element move` landed — it was never in contention
    // with the agent, since the agent was still waiting on the human lease.
    const afterDrag = await readSlide(registry, presentationId);
    const moved = readTranslate(afterDrag, "el-a");
    expect(moved.x).toBeGreaterThan(100);
    expect(moved.y).toBeGreaterThan(100);

    // Releasing the drag lets the agent finally acquire the floor and run
    // its (now-queued) turn to completion.
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);
    expect(await readSlide(registry, presentationId)).toContain(NEW_TITLE);

    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
  }
});
