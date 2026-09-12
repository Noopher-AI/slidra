import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { expect } from "vitest";
import { createDefaultRegistry, type CommandRegistry } from "./cli.js";
import { packDirectory } from "./pack.js";
import { startServe, type RunningServer } from "../../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../../packages/server/src/agent/session.js";
import type { AgentKind } from "../../packages/server/src/agent/adapters.js";
import type { AgentSource } from "../../packages/server/src/agent/manager.js";
import type { CommandRunner } from "../../packages/server/src/agent/probe.js";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.join(e2eDir, "..");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");
const slidraBin = path.join(rootDir, "target/release/slidra");

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * Checks that `apps/web/dist/index.html` and `target/release/slidra`
 * (`slidra serve`'s own read/write path, and this file's own
 * `createDefaultRegistry()`/`registry.dispatch` calls below, both go
 * through the same compiled binary now) exist under `rootDir` — callers
 * must build before running these tests.
 */
export async function requireBuilt(rootDir: string): Promise<void> {
  const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
  await requireExists(webDistIndex, "apps/web/dist does not exist, run npm run build first");
  await requireExists(path.join(rootDir, "target/release/slidra"), "target/release/slidra does not exist, run npm run build first");
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
   * Inject `assets/fonts` into the deck's `fonts/` before
   * packing (ADR-0016 decision 2). Defaults to `false` — most decks are not
   * font-injected, and unconditional injection would change their `.slidra`
   * content and break byte-exact appearance baselines.
   */
  injectFonts?: boolean;
  /** Overrides the default `editing-fake-acp-agent.mjs` fixture. Existing call sites are unaffected — this is optional and defaults to the current fixture. */
  agentFixture?: string;
  /** Merged over the default agent env (`E2E_PRESENTATION_ID`/`E2E_NEW_TITLE`, both still set unless overridden here). */
  agentEnv?: Record<string, string>;
  /**
   * What `serve` starts already pointed at — same field
   * `ServeOptions.initialAgent` (`serve.ts`). Given at all, this wins over
   * the default `agent` config above (`serve.ts`'s own precedence) — used
   * to reach the "unset"/"cli"-sourced starting points `agentEnv` alone
   * cannot express.
   */
  initialAgent?: { kind: AgentKind | null; source: AgentSource };
  /**
   * Injected login-probe runner (`probe.ts`'s `CommandRunner` seam) —
   * given at all, `assumeLoggedIn` is never set (`serve.ts`'s own
   * precedence), so login status is 100% controlled by this function
   * instead of the default `agent` config's real-CLI-probing shortcut.
   */
  runCommand?: CommandRunner;
  /**
   * Resolves each `AgentKind` to the adapter `serve` spawns for it —
   * required alongside `runCommand` so a select doesn't fall through to
   * the real `@zed-industries/*` adapters. Takes this call's own
   * `presentationId` as a second argument (this helper's own convenience,
   * not `ServeOptions.agentManager.resolveAdapter`'s real signature —
   * translated to it below): `AgentManager`'s constructor calls
   * `resolveAdapter` *synchronously* whenever `initialAgent.kind` is
   * non-null, which is before `startServerFor` has returned `presentationId`
   * to its caller — a fixture needing it (e.g.
   * `editing-fake-acp-agent.mjs`'s `E2E_PRESENTATION_ID`) has no other way
   * to receive the real value in time.
   */
  resolveAdapter?: (kind: AgentKind, presentationId: string) => AgentAdapterConfig;
}

export interface StartedServer {
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}

/** Packs `deckDir` (optionally with fonts injected) and starts a real server against it. */
export async function startServerFor(options: StartServerOptions): Promise<StartedServer> {
  const {
    deckDir,
    prefix,
    injectFonts = false,
    agentFixture: agentFixtureOverride,
    agentEnv,
    initialAgent,
    runCommand,
    resolveAdapter,
  } = options;
  const slidraHome = await mkdtemp(path.join(tmpdir(), `slidra-e2e-${prefix}-home-`));
  const slidraDir = await mkdtemp(path.join(tmpdir(), `slidra-e2e-${prefix}-files-`));
  process.env.SLIDRA_HOME = slidraHome;
  // `slidra serve` now spawns the Rust binary for every read and write —
  // `SLIDRA_BIN` must be set before `startServe` below, or startup fails
  // immediately on the presentation load.
  process.env.SLIDRA_BIN = slidraBin;

  let deckStagingDir: string | undefined;
  let packSource = deckDir;
  if (injectFonts) {
    deckStagingDir = await mkdtemp(path.join(tmpdir(), `slidra-e2e-${prefix}-deck-`));
    await cp(deckDir, deckStagingDir, { recursive: true });
    await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
    await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });
    packSource = deckStagingDir;
  }

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(packSource, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixtureOverride ?? agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test does not send a message",
      ...agentEnv,
    },
  };

  const server = await startServe({
    presentationId,
    port: 0,
    agent,
    initialAgent,
    agentManager: {
      runCommand,
      resolveAdapter: resolveAdapter && ((kind) => resolveAdapter(kind, presentationId)),
    },
  });

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
      if (deckStagingDir) await rm(deckStagingDir, { recursive: true, force: true });
    },
  };
}

export interface OpenAppOptions {
  /** Defaults to { width: 1440, height: 900 }. */
  viewport?: { width: number; height: number };
  /** Wait for `waitForAgentConnected`. Defaults to `false`. */
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
    await waitForAgentConnected(page);
  }
  if (waitForFonts) {
    await page.evaluate(() => document.fonts.ready);
  }
  return page;
}

/**
 * Waits for the titlebar's agent indicator to reach the fully-connected
 * state: the `.agent-dot-connected` class (connection established), then
 * `expectedLabel` as its text (the async `GET /api/agent` label has also
 * arrived — see `TitleBar.tsx`'s `agentStatusText`). Between those two
 * moments the dot is connected but still shows the generic "Agent
 * connected" text; callers must not stop at that intermediate text.
 */
export async function waitForAgentConnected(page: Page, expectedLabel = "Claude Code"): Promise<void> {
  await expect.poll(() => page.locator(".agent-dot-connected").count().catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => page.locator(".agent-dot-connected").textContent().catch(() => null), { timeout: 30_000 })
    .toBe(expectedLabel);
}
