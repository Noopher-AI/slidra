import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { expect } from "vitest";
import { createDefaultRegistry, type CommandRegistry } from "@co-motion/cli";
import { packDirectory } from "@co-motion/core";
import { startServe, type RunningServer } from "../../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../../packages/server/src/agent/session.js";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.join(e2eDir, "..");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const presentationFontDir = path.join(rootDir, "packages/core/src/assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * Checks that `packages/web/dist/index.html` and `packages/cli/dist/bin.js`
 * exist under `rootDir`, throwing the same messages the 27 pre-extraction
 * copies used — callers must build before running these tests.
 */
export async function requireBuilt(rootDir: string): Promise<void> {
  const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
  const cliDistBin = path.join(rootDir, "packages/cli/dist/bin.js");
  await requireExists(webDistIndex, "packages/web/dist 不存在，請先執行 npm run build");
  await requireExists(cliDistBin, "packages/cli/dist 不存在，請先執行 npm run build");
}

async function requireExists(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

export interface StartServerOptions {
  /** Deck directory to pack. Required — never defaulted or hardcoded inside this helper. */
  deckDir: string;
  /** Prefix used for the mkdtemp directories, e.g. "grid". */
  prefix: string;
  /**
   * Inject `packages/core/src/assets/fonts` into the deck's `fonts/` before
   * packing (ADR-0016 decision 2). Defaults to `false` — most decks are not
   * font-injected, and unconditional injection would change their `.comot`
   * content and break byte-exact appearance baselines.
   */
  injectFonts?: boolean;
}

export interface StartedServer {
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}

/** Packs `deckDir` (optionally with fonts injected) and starts a real server against it. */
export async function startServerFor(options: StartServerOptions): Promise<StartedServer> {
  const { deckDir, prefix, injectFonts = false } = options;
  const coMotionHome = await mkdtemp(path.join(tmpdir(), `co-motion-e2e-${prefix}-home-`));
  const comotDir = await mkdtemp(path.join(tmpdir(), `co-motion-e2e-${prefix}-files-`));
  process.env.CO_MOTION_HOME = coMotionHome;

  let deckStagingDir: string | undefined;
  let packSource = deckDir;
  if (injectFonts) {
    deckStagingDir = await mkdtemp(path.join(tmpdir(), `co-motion-e2e-${prefix}-deck-`));
    await cp(deckDir, deckStagingDir, { recursive: true });
    await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
    await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });
    packSource = deckStagingDir;
  }

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await packDirectory(packSource, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const presentationId = opened.data!.id;

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

  const server = await startServe({ registry, presentationId, port: 0, agent });

  return {
    server,
    registry,
    presentationId,
    cleanup: async () => {
      await server.close();
      delete process.env.CO_MOTION_HOME;
      await rm(coMotionHome, { recursive: true, force: true });
      await rm(comotDir, { recursive: true, force: true });
      if (deckStagingDir) await rm(deckStagingDir, { recursive: true, force: true });
    },
  };
}

export interface OpenAppOptions {
  /** Defaults to { width: 1440, height: 900 }. */
  viewport?: { width: number; height: number };
  /** Wait for `.agent-dot` to contain "connected". Defaults to `false`. */
  waitForAgent?: boolean;
  /** Wait for `document.fonts.ready`. Defaults to `false`. */
  waitForFonts?: boolean;
}

/**
 * Opens `server.url` and waits for the first slide to render, optionally
 * also for the agent connection and web fonts. Does not manage the page's
 * lifecycle — callers register it with their own `afterEach` cleanup.
 */
export async function openApp(browser: Browser, server: RunningServer, options: OpenAppOptions = {}): Promise<Page> {
  const { viewport = DEFAULT_VIEWPORT, waitForAgent = false, waitForFonts = false } = options;
  const page = await browser.newPage({ viewport });
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  if (waitForAgent) {
    await expect
      .poll(() => page.locator(".agent-dot").textContent().catch(() => null), { timeout: 30_000 })
      .toContain("connected");
  }
  if (waitForFonts) {
    await page.evaluate(() => document.fonts.ready);
  }
  return page;
}
