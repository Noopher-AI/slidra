import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { requireBuilt, startServerFor, openApp, waitForAgentConnected, type StartedServer } from "./helpers/launch.js";

/**
 * Undo/Redo buttons and keyboard shortcuts take effect through the CLI,
 * and the GUI stays in sync after the agent runs `slidra undo`. Four
 * cases: 1. the button; 2. the keyboard shortcut; 3. CLI-to-GUI sync
 * (without reloading the page, relying on the existing SSE live-reload);
 * 4. frozen state (buttons disabled and the shortcut sends no request
 * while the agent holds the lock).
 *
 * Cases 1-3 use the shared `demo/` fixture's `el-title` (a plain `<text>`,
 * see demo/slides/001.svg): `registry.dispatch("text set", ...)` changes
 * it directly, with no need to double-click into edit mode in the
 * browser — the undo/redo buttons and sync path don't care how the text
 * was changed, only undo/redo itself is under test here.
 *
 * Case 4 reuses e2e/freeze.test.ts's existing fake ACP agent fixture
 * (editing-fake-acp-agent.mjs) and freeze flow, measuring "button
 * disabled + Ctrl+Z sends no /api/undo" without re-measuring the
 * server-side freeze semantics themselves (already covered by
 * packages/server/test/agent/freeze.test.ts).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const demoDir = path.join(rootDir, "demo");
const binDir = path.join(rootDir, "node_modules/.bin");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
// editing-fake-acp-agent.mjs requires the `<text id="...">` id to sit
// directly on the `<text>` element itself (extractTextElementId), but
// demo/'s `<text>` has no id (the id sits only on the outer `<g>`) — the
// frozen-state test uses e2e/freeze.test.ts's same fixture deck instead,
// while the other three cases still use demo/ (no need to feed the fake
// agent, they just use registry.dispatch to change the text directly).
const frozenDeckDir = path.join(e2eDir, "fixtures/player-deck");
const VIEWPORT = { width: 1440, height: 900 };
const SLIDE_PATH = "slides/001.svg";
const ELEMENT_ID = "el-title";
const ORIGINAL_TEXT = "Acceptance Demo Deck";
const NEW_TEXT = "Acceptance Demo Deck (edited)";

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function start(prefix: string): Promise<{ started: StartedServer; page: Page }> {
  const started = await startServerFor({ deckDir: demoDir, prefix });
  const page = await openApp(browser, started.server, { viewport: VIEWPORT });
  openPages.push(page);
  return { started, page };
}

async function iframeTitleText(page: Page): Promise<string | null> {
  return page.frameLocator("iframe.slide-frame").locator(`#${ELEMENT_ID} text`).textContent().catch(() => null);
}

async function setTitle(registry: CommandRegistry, presentationId: string, text: string): Promise<void> {
  const result = await registry.dispatch("text set", {
    id: presentationId,
    slidePath: SLIDE_PATH,
    elementId: ELEMENT_ID,
    newText: text,
  });
  if (!result.ok) throw new Error(result.message);
}

it("button: the titlebar's ↶ reverts text changed via registry.dispatch back to its original value", async () => {
  const { started, page } = await start("undo-redo-button");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    await page.locator('.titlebar-icon-button[aria-label="Undo"]').click();
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(ORIGINAL_TEXT);
  } finally {
    await started.cleanup();
  }
});

it("keyboard shortcut: ⌘Z/⇧⌘Z go through the same path", async () => {
  const { started, page } = await start("undo-redo-shortcut");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    await page.locator(".titlebar").click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(ORIGINAL_TEXT);

    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);
  } finally {
    await started.cleanup();
  }
});

it("keyboard shortcut: pressing ⌘Z still undoes after clicking a stage element (focus inside the iframe)", async () => {
  const { started, page } = await start("undo-redo-shortcut-after-stage-click");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    // Clicking an element inside the iframe leaves keyboard focus inside
    // it — deliberately not clicking .titlebar, which is exactly the pitfall
    // the other shortcut test above avoids. Wait for the status bar's
    // selection chip to appear to confirm the click actually landed on
    // the stage.
    await page.frameLocator("iframe.slide-frame").locator(`#${ELEMENT_ID}`).click();
    await expect.poll(() => page.locator(".status-selection-chip").textContent().then((t) => t?.trim() ?? null)).toContain("Selected:");

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(ORIGINAL_TEXT);

    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);
  } finally {
    await started.cleanup();
  }
});

it("CLI-GUI sync: after the agent runs slidra undo (registry.dispatch(\"undo\")), the GUI reverts on its own without a page reload", async () => {
  const { started, page } = await start("undo-redo-cli-sync");
  try {
    await expect.poll(() => iframeTitleText(page)).toBe(ORIGINAL_TEXT);
    await setTitle(started.registry, started.presentationId, NEW_TEXT);
    await expect.poll(() => iframeTitleText(page), { timeout: 10_000 }).toBe(NEW_TEXT);

    // Simulates the agent issuing `slidra undo`: calls registry directly,
    // bypassing the browser.
    const undo = await started.registry.dispatch("undo", { id: started.presentationId });
    expect(undo.ok).toBe(true);

    // No page.reload(): relies on the existing file watcher -> SSE
    // /api/events -> live-reload.ts -> controller.reload() chain to sync
    // the view on its own.
    await expect.poll(() => iframeTitleText(page), { timeout: 30_000 }).toBe(ORIGINAL_TEXT);
  } finally {
    await started.cleanup();
  }
});

// ── Frozen state: reuses e2e/freeze.test.ts's fake ACP agent fixture ──────

async function startFrozenServer(): Promise<{ server: RunningServer; registry: CommandRegistry; presentationId: string; cleanup: () => Promise<void> }> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-undoredo-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-undoredo-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(frozenDeckDir, slidraPath);
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
      E2E_NEW_TITLE: "frozen test doesn't look at this title",
      E2E_FREEZE_HOLD_MS: "3000",
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
    },
  };
}

async function editingFrozen(page: Page): Promise<boolean> {
  const banner = await page.locator(".editing-frozen-banner").count();
  return banner > 0;
}

it("frozen state: Undo/Redo buttons are disabled while the agent holds the lock, and ⌘Z sends no /api/undo request", async () => {
  const frozen = await startFrozenServer();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    openPages.push(page);
    const undoRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/undo")) undoRequests.push(request.url());
    });
    await page.goto(frozen.server.url);
    await page.frameLocator("iframe.slide-frame").locator("svg text").first().waitFor({ timeout: 30_000 });
    await waitForAgentConnected(page);

    await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
    await page.locator(".chat-input textarea").fill("change the title");
    await page.locator(".chat-input button").click();

    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(true);
    expect(await page.locator('.titlebar-icon-button[aria-label="Undo"]').isDisabled()).toBe(true);
    expect(await page.locator('.titlebar-icon-button[aria-label="Redo"]').isDisabled()).toBe(true);

    await page.locator(".titlebar").click();
    await page.keyboard.press("ControlOrMeta+z");
    expect(undoRequests).toEqual([]);

    await expect.poll(() => editingFrozen(page), { timeout: 30_000 }).toBe(false);
  } finally {
    await frozen.cleanup();
  }
});
