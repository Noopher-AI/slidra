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
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * The browser end-to-end smoke test (issue #16). It exists to catch one
 * kind of failure and no other: the seam between the pieces. The frontend
 * modules, the server routes and the ACP wiring each have their own tests
 * already; what nothing else covers is "every part is fine on its own and
 * the whole thing still does not move".
 *
 * Everything here is real except the agent: a real `startServe`, the real
 * built `packages/web/dist` bundle, a real Chromium, a real presentation
 * created through the real `new`/`open` commands, and a real `slidra`
 * binary resolved from PATH. Only the agent is a fake ACP subprocess, so
 * the test needs neither Claude Code installed nor any API quota.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/export-deck");
// Where npm's workspace linking puts the `slidra` executable. This is
// the PATH the fake agent's shell command resolves through — the same
// lookup that failed during #8's manual acceptance.
const binDir = path.join(rootDir, "node_modules/.bin");

const NEW_TITLE = "smoke-test-changed-title";

let browser: Browser;
let slidraHome: string;
let slidraDir: string;
let registry: CommandRegistry;
let server: RunningServer;

beforeAll(async () => {
  // A build is a precondition of this test, not part of it: the test runs
  // against whatever is in packages/web/dist, which is exactly what makes
  // "the bundle itself is broken" a failure it can see. Missing build
  // output is an explicit error — never a skip, never a silent pass.
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, run npm run build first");

  browser = await chromium.launch();
  // Printed so a passing run visibly says which real browser it drove,
  // rather than leaving "a browser was involved" to be taken on trust.
  console.log(`Browser: Chromium ${browser.version()}`);

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  registry = createDefaultRegistry();
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
      // Deliberately NOT `${binDir}:${process.env.PATH}`. The ambient PATH
      // npm sets up also contains every ancestor directory's
      // node_modules/.bin — including the main checkout's, when this runs
      // in a git worktree — so inheriting it lets `slidra` resolve to
      // some *other* copy of this project and hides a broken link in this
      // one. The only two entries the agent's shell command legitimately
      // needs are this workspace's bin directory and the directory holding
      // the `node` its `#!/usr/bin/env node` shebang looks up.
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: NEW_TITLE,
    },
  };

  // Port 0: the OS assigns a free port and we read the real one back.
  server = await startServe({ policy: openPolicy, presentationId, port: 0, agent });
});

afterAll(async () => {
  // Browser first, server second — the order is load-bearing. The page's
  // EventSource reconnects on its own whenever a stream ends, so closing
  // the server while a tab is still open lets a fresh /api/chat/stream
  // request arrive *after* close()'s disposers have already drained the
  // set of live streams. That stream is then never closed, and
  // `server.close()` waits on it forever (it waits for established
  // connections rather than severing them). Killing the browser first
  // removes the thing that can reconnect. Running this file on its own
  // happened not to hit it; running it after other e2e files did.
  await browser?.close();
  await server?.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  // Guarded: beforeAll can fail before these exist (e.g. no build output),
  // and an unguarded rm(undefined) here would bury that error under its own.
  if (slidraHome) await rm(slidraHome, { recursive: true, force: true });
  if (slidraDir) await rm(slidraDir, { recursive: true, force: true });
});

it("sending a chat message in the browser actually changes the SVG text on the canvas", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  // Reports an uncaught page error in place of the (absent) slide text, so
  // a broken bundle fails saying *why* rather than just timing out.
  const currentSlideText = async (): Promise<string | null> => {
    if (pageErrors.length > 0) return `Page error: ${pageErrors.join("; ")}`;
    return slideText.textContent().catch(() => null);
  };

  // The bundle has to boot, fetch the presentation and paint the slide for
  // this to ever resolve — a broken dist fails right here.
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("Export Slide 1");

  // The send button is disabled until the chat SSE stream is open, so
  // waiting for it is also waiting for the stream.
  await page.locator('.chat-input button[type="submit"]:not([disabled])').waitFor({ timeout: 30_000 });
  await page.locator(".chat-input textarea").fill("change the title");
  await page.getByRole("button", { name: "Send" }).click();

  // The whole chain in one assertion: POST /api/chat -> fake agent ->
  // fs/read_text_file -> permission allowlist -> `slidra text set` off
  // PATH -> file watcher -> /api/events -> canvas reload -> new SVG text.
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(NEW_TITLE);

  expect(pageErrors).toEqual([]);
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
