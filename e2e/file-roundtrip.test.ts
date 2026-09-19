// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, createDeckServerRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import { openPolicy } from "../packages/server/src/policy/open.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { requireBuilt, startServerFor, openApp } from "./helpers/launch.js";
import { browserFetch } from "./helpers/browser-fetch.js";

/**
 * Open/Save round-trips a `.slidra` byte-for-byte, and `POST /api/open`
 * clears undo history and replaces the served presentation without changing
 * its id.
 *
 * Pure HTTP-level tests: `startServe` + real `fetch`, no browser, matching
 * `packages/server/test/serve.test.ts`'s own convention — the agent is a
 * fixture nothing here ever spawns (lazy on first `/api/chat`, same
 * reasoning as that file's `fakeAgent`).
 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const deckDir = path.join(rootDir, "e2e/fixtures/export-deck");
const fakeAgentFixture = path.join(rootDir, "packages/server/test/agent/fixtures/fake-acp-agent.mjs");
const fakeAgent: AgentAdapterConfig = {
  kind: "claude",
  label: "Claude Code",
  command: process.execPath,
  args: [fakeAgentFixture],
};

interface Harness {
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  slidraPath: string;
  slidraHome: string;
  slidraDir: string;
  deckFolder: string;
  staticDir: string;
}

async function startHarness(): Promise<Harness> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-files-"));
  const deckFolder = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-deckfolder-"));
  const staticDir = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-static-"));
  await mkdir(staticDir, { recursive: true });
  await writeFile(path.join(staticDir, "index.html"), '<script id="slidra-bootstrap" type="application/json">__SLIDRA_BOOTSTRAP__</script>');
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const slidraPath = path.join(slidraDir, "a.slidra");
  await packDirectory(deckDir, slidraPath);
  // [E6.T2]: POST /api/open now lands the uploaded deck in the configured
  // deck folder (default ~/Slidra) rather than reopening the current
  // presentation in place — pointed at an isolated temp dir so this test
  // never touches the real host home directory.
  await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder }));

  const server = await startServe({ policy: openPolicy, presentationId: slidraPath, port: 0, agent: fakeAgent, staticDir });
  const html = await (await fetch(server.url)).text();
  const bootstrap = JSON.parse(html.match(/<script id="slidra-bootstrap" type="application\/json">([^<]+)<\/script>/)![1]!) as { workbenchId: string; deck: { url: string } };
  const presentationId = bootstrap.workbenchId;
  const registry = createDeckServerRegistry(bootstrap.deck.url, presentationId);

  return { server, registry, presentationId, slidraPath, slidraHome, slidraDir, deckFolder, staticDir };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.server.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(harness.slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(harness.slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(harness.deckFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(harness.staticDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let harness: Harness | undefined;
let secondHome: string | undefined;

afterEach(async () => {
  if (harness) {
    await stopHarness(harness);
    harness = undefined;
  }
  if (secondHome) {
    await rm(secondHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    secondHome = undefined;
  }
});

describe("continuous save (NOOP-422)", () => {
  it("an edit left alone is durable in the deck file within the debounce window, with no author action, byte-for-byte after reopening into a second SLIDRA_HOME (AC2)", async () => {
    harness = await startHarness();
    const { server, slidraPath } = harness;

    const setResponse = await browserFetch(server.url, "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "text set",
        input: { slidePath: "slides/001.svg", elementId: "el-title", newText: "roundtrip edited" },
      }),
    });
    expect(setResponse.status).toBe(200);

    // Re-open the edited file through a second real deck-server in a completely
    // separate SLIDRA_HOME. Direct crate writes are durable when the command
    // returns; there is no Node-owned dirty/save-state phase to observe.
    secondHome = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-home2-"));
    const previousHome = process.env.SLIDRA_HOME;
    process.env.SLIDRA_HOME = secondHome;
    // slidra serve now spawns the Rust binary for every read/write.
    process.env.SLIDRA_BIN = slidraBin;
    try {
      const secondServer = await startServe({ policy: openPolicy, presentationId: slidraPath, port: 0, agent: fakeAgent, staticDir: harness.staticDir });
      try {
        const html = await (await fetch(secondServer.url)).text();
        const bootstrap = JSON.parse(html.match(/<script id="slidra-bootstrap" type="application\/json">([^<]+)<\/script>/)![1]!) as { workbenchId: string; deck: { url: string } };
        const secondRegistry = createDeckServerRegistry(bootstrap.deck.url, bootstrap.workbenchId);
        const editedSlide = await secondRegistry.dispatch<{ content: string }>("cat", { path: "slides/001.svg" });
        expect(editedSlide.ok).toBe(true);
        expect(editedSlide.data!.content).toContain("roundtrip edited");
      } finally {
        await secondServer.close();
      }
    } finally {
      process.env.SLIDRA_HOME = previousHome;
      // slidra serve now spawns the Rust binary for every read/write.
      process.env.SLIDRA_BIN = slidraBin;
    }
  });
});

describe("POST /api/open", () => {
  it("creates an independent new deck in the deck folder without switching or touching the currently served presentation's unsaved changes", async () => {
    harness = await startHarness();
    const { server, presentationId, deckFolder } = harness;

    // An unsaved edit on the currently served presentation, made before the
    // upload — [E6.T2] retired /api/open's old "reopen the served
    // presentation in place" behavior (and, with it, the discard-unsaved
    // gate that protected against exactly that): the upload below must
    // neither touch nor require discarding this edit.
    const setResponse = await browserFetch(server.url, "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "text set",
        input: { slidePath: "slides/001.svg", elementId: "el-title", newText: "should survive open" },
      }),
    });
    expect(setResponse.status).toBe(200);

    const otherDir = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-other-"));
    try {
      const otherSlidraPath = path.join(otherDir, "other.slidra");
      await packDirectory(path.join(rootDir, "docs/demo"), otherSlidraPath);
      const otherBytes = await readFile(otherSlidraPath);

      const openResponse = await fetch(`${server.url}/api/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-slidra-file-name": encodeURIComponent("other.slidra"),
        },
        body: otherBytes,
      });
      expect(openResponse.status).toBe(200);
      const openBody = (await openResponse.json()) as { ok: true; id: string; fileName: string };
      expect(openBody.ok).toBe(true);
      expect(openBody.id).not.toBe(presentationId);

      // The currently served presentation is unchanged: still the harness's
      // own deck, and the pre-upload edit is still there.
      const presentationResponse = await fetch(`${server.url}/api/presentation`);
      const presentation = (await presentationResponse.json()) as { name: string };
      expect(presentation.name).toBe("Export test deck");
      const currentSlide = await harness.registry.dispatch<{ content: string }>("cat", {
        id: presentationId,
        path: "slides/001.svg",
      });
      expect(currentSlide.data!.content).toContain("should survive open");

      // The uploaded deck exists as its own, independently openable deck
      // file inside the configured deck folder (AC1) — never touching
      // presentationId's own deck file.
      const uploaded = await harness.registry.dispatch<{ content: string }>("cat", {
        id: openBody.id,
        path: "project.json",
      });
      expect(uploaded.ok).toBe(true);
      expect(openBody.fileName).toBe("other.slidra");
      const stored = await readFile(path.join(deckFolder, "other.slidra"));
      expect(stored.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
    } finally {
      await rm(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("no manual Save entry point anywhere in the UI (AC1, via a real browser — the describe blocks above are pure HTTP)", () => {
  let browser: Browser;

  it("no Save button exists, and Cmd+S sends no POST to /api/save or /api/save/flush", async () => {
    await requireBuilt(rootDir);
    browser = await chromium.launch();
    const started = await startServerFor({ deckDir, prefix: "roundtrip-no-save-entry" });
    try {
      const page = await openApp(browser, started.server);

      // The title bar's old Save button is gone entirely — not just
      // relabeled or disabled.
      expect(await page.locator('.titlebar-button[title="Save (⌘S)"]').count()).toBe(0);
      expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);

      const saveRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/save")) {
          saveRequests.push(request.url());
        }
      });

      // A real edit first, so there is something a manual save COULD have
      // acted on — pressing Cmd+S over a clean deck would prove nothing.
      const setResult = await started.registry.dispatch("text set", {
        id: started.presentationId,
        slidePath: "slides/001.svg",
        elementId: "el-title",
        newText: "Cmd+S no-op test",
      });
      expect(setResult.ok).toBe(true);

      // Focus is deliberately left on the parent document (no click into
      // the slide): a keydown listener bound there is the most directly
      // reachable path for a global keyboard shortcut to exist at all.
      await page.keyboard.press("Meta+s");
      // Gives a keydown handler, if one still existed, time to fire its
      // fetch — this is the one place a negative assertion needs a wait.
      await page.waitForTimeout(300);

      expect(saveRequests).toEqual([]);
    } finally {
      await browser.close();
      await started.cleanup();
    }
  });
});
