import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Per ADR-0013: a locked element cannot be selected in view mode at all —
 * `selection-runtime.js`'s `findSelectable` returns `null` for a container
 * carrying `data-slidra-lock="true"`. Modeled on `e2e/selection.test.ts`'s
 * fixture-deck posture: real Playwright mouse clicks only, never
 * `element.click()` inside page script (see that file's header comment for
 * why that distinction actually matters here).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const lockedDeckDir = path.join(e2eDir, "fixtures/locked-element-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");
  browser = await chromium.launch();
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

async function startServerFor(
  deckDir: string,
): Promise<{ server: RunningServer; registry: CommandRegistry; presentationId: string; cleanup: () => Promise<void> }> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-lock-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-lock-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
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
      E2E_NEW_TITLE: "this test does not send a message",
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

async function openApp(server: RunningServer): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  return page;
}

it("clicking a locked element does not select it: no status bar text, no selection box", async () => {
  const { server, cleanup } = await startServerFor(lockedDeckDir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    // A real mouse click (locator click), never page-script `element.click()`
    // — see this file's header note and e2e/selection.test.ts's own posture
    // comment for why that distinction matters (pointer-events gaps a DOM
    // .click() would not catch).
    await slideFrame.locator("#el-locked").click();

    // Give the postMessage round trip a moment, then assert nothing selected.
    await page.waitForTimeout(300);
    expect((await selName.textContent())?.trim()).toBe("");

    const boxDisplay = await page.evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement | null;
      const sel = host?.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay === null || boxDisplay === "none").toBe(true);
  } finally {
    await cleanup();
  }
});

it("a locked child inside an unlocked parent group: clicking the child does not select it, and does not fall back to selecting the unlocked parent group", async () => {
  const { server, cleanup } = await startServerFor(lockedDeckDir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    // Real mouse click on the locked child — see this file's header note on
    // why a locator click (not page-script .click()) is required here.
    await slideFrame.locator("#el-locked-child").click();

    await page.waitForTimeout(300);
    expect((await selName.textContent())?.trim()).toBe("");

    const boxDisplay = await page.evaluate(() => {
      const host = document.querySelector("[data-slidra-selection-host]") as HTMLElement | null;
      const sel = host?.shadowRoot?.querySelector(".sel") as HTMLElement | null;
      return sel ? getComputedStyle(sel).display : null;
    });
    expect(boxDisplay === null || boxDisplay === "none").toBe(true);
  } finally {
    await cleanup();
  }
});

it("clicking a neighboring unlocked element still selects it normally", async () => {
  const { server, cleanup } = await startServerFor(lockedDeckDir);
  try {
    const page = await openApp(server);
    const slideFrame = page.frameLocator("iframe.slide-frame");
    const selName = page.locator(".status-selection-chip");

    await slideFrame.locator("#el-unlocked").click();

    await expect.poll(() => selName.textContent().then((t) => t?.trim())).toBe("Selected: 未鎖定方塊");
  } finally {
    await cleanup();
  }
});
