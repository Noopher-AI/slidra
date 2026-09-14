// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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
 * A legal slide element can carry its own inline `style="opacity:1"`.
 * Inline style normally wins the CSS cascade over any injected stylesheet
 * rule, regardless of that rule's specificity — without `!important` on
 * both the hide stylesheet (player-plan.ts) and the runtime's own reveal
 * (player-runtime.js), such an element flashes fully visible at the very
 * start of play, defeating the guarantee that entering play mode never
 * flashes the full content. This is a real-browser cascade question, not
 * something jsdom can answer reliably, so it is tested here end to end
 * rather than only at the unit level.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/inline-opacity-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let slidraHome: string;
let slidraDir: string;
let server: RunningServer;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, run npm run build first");

  browser = await chromium.launch();

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-inlineop-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-inlineop-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "inline-opacity-deck.slidra");
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

it('an element with its own inline style="opacity:1" is still hidden before entering and visible after advancing', async () => {
  const page = await browser.newPage();
  await page.goto(server.url);

  const stubborn = page.frameLocator("iframe.slide-frame").locator("#el-stubborn");
  await expect.poll(() => stubborn.textContent().catch(() => null), { timeout: 30_000 }).toBe("Stubborn Text");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  const opacityOf = () => stubborn.evaluate((el) => getComputedStyle(el).opacity);

  // The element's own inline style says opacity:1. If the injected hide
  // rule loses the cascade to it, this would read "1" instead of "0" —
  // the exact flash-of-full-content bug this test exists to catch.
  await expect.poll(opacityOf, { timeout: 10_000 }).toBe("0");

  await page.keyboard.press("ArrowRight");
  await expect.poll(opacityOf, { timeout: 10_000 }).toBe("1");
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
