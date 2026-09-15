// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { AGENT_KINDS, type AgentKind } from "../packages/server/src/agent/adapters.js";
import type { CommandOutcome, CommandRunner } from "../packages/server/src/agent/probe.js";
import { openApp, requireBuilt, startServerFor, type StartedServer } from "./helpers/launch.js";

/**
 * The chat panel's agent / model chips and their menus (AgentPicker.tsx) and the agent-
 * driven empty state, end to end. This started life as the settings
 * dialog's Agent tab test; the dialog and the status
 * bar gear are gone — everything the author used to do there is a pill
 * under the chat box now (a chip that opens a menu), so the scenarios stay and only the selectors and
 * the "open the dialog" step changed.
 *
 * Login status is fully controlled by an injected `CommandRunner`
 * (`probe.ts`'s seam) — no real `claude`/`codex` CLI is ever consulted.
 * `editing-fake-acp-agent.mjs` (already used by e2e/freeze.test.ts and
 * friends) is reused for the one scenario that needs a real
 * text-changing session.
 *
 * Assertion style matches e2e/freeze.test.ts: vitest's plain chai-based
 * `expect`, every assertion `expect.poll(() => locator…)`.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/agent-settings-deck");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const binDir = path.join(rootDir, "node_modules/.bin");

const outcome = (partial: Partial<CommandOutcome> = {}): CommandOutcome => ({ code: 0, stdout: "", stderr: "", ...partial });

/** A single fixed-adapter's `AgentAdapterConfig`, pointed at `editing-fake-acp-agent.mjs` with the real `presentationId` (per launch.ts's contract) and a per-kind `E2E_NEW_TITLE` so a slide edit can be attributed to whichever kind actually ran it. */
function fixtureAdapterFor(kind: AgentKind, presentationId: string, newTitle: string): AgentAdapterConfig {
  return {
    kind,
    label: kind === "claude" ? "Claude Code" : "Codex",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: newTitle,
    },
  };
}

let browser: Browser;
let openPages: Page[] = [];
let activeServer: StartedServer | undefined;

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
  await activeServer?.cleanup();
  activeServer = undefined;
});

async function openPage(server: StartedServer["server"]): Promise<Page> {
  const page = await openApp(browser, server);
  openPages.push(page);
  return page;
}

/** Opens the agent chip's menu (the chip is enabled once `GET /api/agent` has answered). */
async function openAgentMenu(page: Page): Promise<void> {
  const chip = page.locator('.chat-chip[data-chip="agent"]');
  await expect.poll(() => chip.isEnabled().catch(() => false), { timeout: 10_000 }).toBe(true);
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  await expect.poll(() => page.locator('.chat-chip-menu [data-kind="claude"]').count()).toBeGreaterThan(0);
}

async function itemChecked(page: Page, kind: string): Promise<string | null> {
  return page.locator(`.chat-chip-menu [data-kind="${kind}"]`).getAttribute("aria-checked");
}

async function itemDetail(page: Page, kind: string): Promise<string | null> {
  return page.locator(`.chat-chip-menu [data-kind="${kind}"] .chat-chip-menu-detail`).textContent();
}

async function textOf(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).textContent();
}

// ─────────────────────────────────────────────────────────────────────────
// The three states — not logged in / available / probing — show the right card text and actions; the not-logged-in row's login command can be copied.
// ─────────────────────────────────────────────────────────────────────────

it("agent menu shows active/not-logged-in/probing based on probe results, with a login command on the not-logged-in row", async () => {
  // An artificial pause before a probe resolves gives "Checking…" a
  // deterministic observation window. Only re-probes are delayed (not the
  // initial mount GET) so the menu opens against already-known data.
  const PROBE_DELAY_MS = 1200;
  let probeCount = 0;
  const runner: CommandRunner = async (command) => {
    probeCount++;
    // One probe per agent kind makes up the initial mount round; only what
    // comes after it is a re-probe, and only those are delayed.
    if (probeCount > AGENT_KINDS.length) await new Promise((resolve) => setTimeout(resolve, PROBE_DELAY_MS));
    if (command === "claude") return outcome({ stdout: '{"loggedIn":true}' });
    if (command === "codex") return outcome({ code: 1, stdout: "Not logged in" });
    // Every other kind (today: `pi`, probed by running a script through
    // this very Node binary rather than a bare command name) answers
    // logged-out. This test asserts on the claude/codex rows only, but the
    // runner still has to answer for all of them — a throw here fails the
    // whole probe round and leaves the chip disabled with no cards.
    return outcome({ code: 1 });
  };

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a1",
    initialAgent: { kind: "claude", source: "settings" },
    runCommand: runner,
    resolveAdapter: (kind, presentationId) => fixtureAdapterFor(kind, presentationId, "unused"),
  });

  const page = await openPage(activeServer.server);
  await openAgentMenu(page);

  // Initial load (no delay): claude is active, codex is not logged in and that row carries a login command.
  await expect.poll(() => itemChecked(page, "claude"), { timeout: 10_000 }).toBe("true");
  expect(await itemDetail(page, "claude")).toBe("In use");
  expect(await itemChecked(page, "codex")).toBe("false");
  expect(await itemDetail(page, "codex")).toBe("Not signed in · codex login");

  // Click "re-probe": this probe is delayed, so the probing label has a deterministic observation window.
  const probeButton = page.locator(".chat-chip-menu-action");
  await probeButton.click();
  await expect.poll(() => probeButton.textContent()).toBe("Checking…");
  await expect.poll(() => itemDetail(page, "codex")).toBe("Checking…");
  await expect.poll(() => probeButton.textContent(), { timeout: 10_000 }).toBe("Re-check sign-in status");
  expect(await itemDetail(page, "claude")).toBe("In use");
});

// ─────────────────────────────────────────────────────────────────────────
// Clicking "re-probe" after the probe result changes updates the card state.
// ─────────────────────────────────────────────────────────────────────────

it("menu status updates with probe results after clicking re-probe", async () => {
  let codexLoggedIn = false;
  const runner: CommandRunner = async (command) => {
    if (command === "claude") return outcome({ stdout: '{"loggedIn":true}' });
    if (command === "codex") return codexLoggedIn ? outcome() : outcome({ code: 1, stdout: "Not logged in" });
    return outcome({ code: 1 }); // every other kind: logged out (see the runner above)
  };

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a2",
    initialAgent: { kind: "claude", source: "settings" },
    runCommand: runner,
    resolveAdapter: (kind, presentationId) => fixtureAdapterFor(kind, presentationId, "unused"),
  });

  const page = await openPage(activeServer.server);
  await openAgentMenu(page);

  await expect.poll(() => itemDetail(page, "codex"), { timeout: 10_000 }).toBe("Not signed in · codex login");

  codexLoggedIn = true;
  await page.locator(".chat-chip-menu-action").click();

  await expect.poll(() => itemDetail(page, "codex"), { timeout: 10_000 }).toBe("Available");
});

// ─────────────────────────────────────────────────────────────────────────
// Switching agents produces a system message in chat, the next message is
// handled by the new agent, and the buttons are disabled while the edit lock holds.
// ─────────────────────────────────────────────────────────────────────────

it("switching agents from the menu — system message, chip, next message, and edit lock", async () => {
  const FREEZE_HOLD_MS = 1500;
  const bothLoggedIn: CommandRunner = async () => outcome({ stdout: '{"loggedIn":true}' });

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a3",
    initialAgent: { kind: "claude", source: "cli" },
    runCommand: bothLoggedIn,
    resolveAdapter: (kind, presentationId) => {
      const config = fixtureAdapterFor(kind, presentationId, kind === "claude" ? "Title changed by Claude" : "Title changed by Codex");
      return { ...config, env: { ...config.env, E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS) } };
    },
  });

  const server = activeServer.server;
  const page = await openPage(server);
  await openAgentMenu(page);

  // claude is the currently active agent, set via the command line: in use, with an extra menu row explaining the source.
  await expect.poll(() => itemChecked(page, "claude"), { timeout: 10_000 }).toBe("true");
  expect(await textOf(page, ".chat-chip-menu-hint")).toBe("Set via the command line for this session");

  await page.locator('.chat-chip-menu [data-kind="codex"]').click();

  // The divider text is the server's own (`AgentManager.buildDividerText`), not the
  // browser's — [E6.T7] moved it there and appended the `slidra chat-history` pointer
  // its AC4 requires, so the full sentence is what reaches `.chat-system`.
  await expect
    .poll(() => textOf(page, ".chat-system"), { timeout: 10_000 })
    .toBe(
      "Switched to Codex. It will handle messages from here. Above is the conversation before it joined — the agent has no memory of it; it can read it back with `slidra chat-history` if it needs to.",
    );
  await expect.poll(() => textOf(page, ".agent-dot-connected")).toBe("Codex");
  // The menu collapses once a selection is made; reopening it shows codex checked and the command-line hint gone.
  expect(await page.locator(".chat-chip-menu").count()).toBe(0);
  await openAgentMenu(page);
  await expect.poll(() => itemChecked(page, "codex")).toBe("true");
  expect(await page.locator(".chat-chip-menu-hint").count()).toBe(0);
  await page.keyboard.press("Escape");

  // `editing-fake-acp-agent.mjs` only ever answers its session's very first
  // real author prompt — one message proves both: the next message really
  // reaches the new (codex) session, AND the editing lock it takes disables
  // the menu's agent rows for the freeze window before that session's turn ends.
  await page.locator(".chat-input textarea").fill("change the title");
  await page.locator('.chat-input button[type="submit"]').click();

  async function isFrozen(): Promise<boolean> {
    const response = await page.request.get(`${server.url}/api/editing`);
    return ((await response.json()) as { frozen: boolean }).frozen;
  }
  await expect.poll(isFrozen, { timeout: 5_000 }).toBe(true);

  // While the edit lock is held: both menu rows are disabled and show a fixed hint.
  await openAgentMenu(page);
  const rows = page.locator(".chat-chip-menu [data-kind]");
  const disabledFlags = await Promise.all((await rows.all()).map((row) => row.isDisabled()));
  expect(disabledFlags.every(Boolean)).toBe(true);
  expect(await textOf(page, ".chat-chip-menu-hint")).toBe("The agent is editing — switching will have to wait");
  await page.keyboard.press("Escape");

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent(), { timeout: 10_000 }).toBe("Title changed by Codex");
  await expect.poll(isFrozen, { timeout: 10_000 }).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────
// With no agent, the chat panel shows an empty state and "Open settings" opens the dialog.
// ─────────────────────────────────────────────────────────────────────────

it("with no agent, the chat panel shows an empty state, the input is disabled, and one can be picked from the chip menu", async () => {
  const bothLoggedIn: CommandRunner = async () => outcome({ stdout: '{"loggedIn":true}' });

  activeServer = await startServerFor({
    deckDir,
    prefix: "agent-settings-a4",
    initialAgent: { kind: null, source: "none" },
    runCommand: bothLoggedIn,
    resolveAdapter: (kind, presentationId) => fixtureAdapterFor(kind, presentationId, "unused"),
  });

  const page = await openPage(activeServer.server);

  await expect.poll(() => page.locator(".chat-empty-state").count(), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(await textOf(page, ".chat-empty-state")).toContain("No agent selected");
  expect(await page.locator(".chat-input textarea").isDisabled()).toBe(true);
  expect(await page.locator('.chat-input button[type="submit"]').isDisabled()).toBe(true);
  await expect.poll(() => textOf(page, '.chat-chip[data-chip="agent"]'), { timeout: 10_000 }).toContain("Select agent");

  await openAgentMenu(page);
  expect(await itemChecked(page, "claude")).toBe("false");
  expect(await itemChecked(page, "codex")).toBe("false");
  await page.locator('.chat-chip-menu [data-kind="claude"]').click();
  await expect.poll(() => textOf(page, ".agent-dot-connected"), { timeout: 10_000 }).toBe("Claude Code");
  await expect.poll(() => page.locator(".chat-empty-state").count()).toBe(0);
});
