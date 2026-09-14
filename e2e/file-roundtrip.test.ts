// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { listDeckFiles, readDeckFileBytes, readDeckFileText } from "./helpers/deck.js";
import { deckPathFor } from "../packages/server/src/slidra/home.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { requireBuilt, startServerFor, openApp } from "./helpers/launch.js";

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
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const slidraPath = path.join(slidraDir, "a.slidra");
  await packDirectory(deckDir, slidraPath);
  const registry = createDefaultRegistry();
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  // [E6.T2]: POST /api/open now lands the uploaded deck in the configured
  // deck folder (default ~/Slidra) rather than reopening the current
  // presentation in place — pointed at an isolated temp dir so this test
  // never touches the real host home directory.
  await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder }));

  const server = await startServe({ presentationId, port: 0, agent: fakeAgent, staticDir });

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

describe("file round-trip via POST /api/save", () => {
  it("an edit saved through /api/save survives a reopen into a second SLIDRA_HOME, byte-for-byte", async () => {
    harness = await startHarness();
    const { server, slidraPath } = harness;

    const setResponse = await fetch(`${server.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "text set",
        input: { slidePath: "slides/001.svg", elementId: "el-title", newText: "roundtrip edited" },
      }),
    });
    expect(setResponse.status).toBe(200);

    const saveResponse = await fetch(`${server.url}/api/save`, { method: "POST" });
    expect(saveResponse.status).toBe(200);
    await expect(saveResponse.json()).resolves.toEqual({ ok: true });

    const stateResponse = await fetch(`${server.url}/api/save-state`);
    await expect(stateResponse.json()).resolves.toEqual({ known: true, dirty: false, fileName: "a.slidra" });

    // The deck file this server is still running against.
    const firstDeckPath = await deckPathFor(harness.presentationId);
    const firstFiles = await listDeckFiles(firstDeckPath);

    // Re-open the just-saved `a.slidra` into a completely separate
    // SLIDRA_HOME and compare every file byte-for-byte.
    secondHome = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-home2-"));
    const previousHome = process.env.SLIDRA_HOME;
    process.env.SLIDRA_HOME = secondHome;
    // slidra serve now spawns the Rust binary for every read/write.
    process.env.SLIDRA_BIN = slidraBin;
    try {
      const secondOpened = await harness.registry.dispatch<{ id: string }>("open", { path: slidraPath });
      const secondId = secondOpened.data!.id;
      const secondDeckPath = await deckPathFor(secondId);
      const secondFiles = await listDeckFiles(secondDeckPath);
      expect(secondFiles).toEqual(firstFiles);

      for (const relativePath of firstFiles) {
        const firstBytes = await readDeckFileBytes(firstDeckPath, relativePath);
        const secondBytes = await readDeckFileBytes(secondDeckPath, relativePath);
        if (relativePath === "project.json") {
          expect(JSON.parse(secondBytes.toString("utf-8"))).toEqual(JSON.parse(firstBytes.toString("utf-8")));
        } else {
          expect(secondBytes.equals(firstBytes)).toBe(true);
        }
      }

      const editedSlide = await readDeckFileText(secondDeckPath, "slides/001.svg");
      expect(editedSlide).toContain("roundtrip edited");
    } finally {
      process.env.SLIDRA_HOME = previousHome;
      // slidra serve now spawns the Rust binary for every read/write.
      process.env.SLIDRA_BIN = slidraBin;
    }
  });

  it("POST /api/save without a sourcePath (a legacy registry entry) is refused with 400, not a guessed path", async () => {
    harness = await startHarness();
    const { server, slidraHome, presentationId } = harness;

    // Simulate a registry entry created before sourcePath/savedAt tracking
    // existed: no sourcePath/savedAt at all.
    const registryPath = path.join(slidraHome, "projects.json");
    const raw = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, { deckPath: string }>;
    const deckPath = raw[presentationId].deckPath;
    raw[presentationId] = { deckPath };
    await writeFile(registryPath, JSON.stringify(raw));

    const saveResponse = await fetch(`${server.url}/api/save`, { method: "POST" });
    expect(saveResponse.status).toBe(400);
    const body = (await saveResponse.json()) as { error: string };
    expect(body.error).toContain("no file path to write back to");
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
    const setResponse = await fetch(`${server.url}/api/command`, {
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
      // own deck, and the pre-upload unsaved edit is still there (dirty,
      // never discarded — there is no discard-unsaved header any more).
      const presentationResponse = await fetch(`${server.url}/api/presentation`);
      const presentation = (await presentationResponse.json()) as { name: string };
      expect(presentation.name).toBe("Export test deck");
      const stateResponse = await fetch(`${server.url}/api/save-state`);
      await expect(stateResponse.json()).resolves.toMatchObject({ known: true, dirty: true });

      // The uploaded deck exists as its own, independently openable deck
      // file inside the configured deck folder (AC1) — never touching
      // presentationId's own deck file.
      const uploadedDeckPath = await deckPathFor(openBody.id);
      expect(path.dirname(uploadedDeckPath)).toBe(deckFolder);
      expect(uploadedDeckPath).not.toBe(await deckPathFor(presentationId));
    } finally {
      await rm(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("Cmd+S keyboard entry point (via a real browser — the two describe blocks above are pure HTTP, this is the only one exercising App.tsx's keydown handler)", () => {
  let browser: Browser;

  it("pressing Cmd+S sends POST /api/save, and GET /api/save-state then reports dirty: false", async () => {
    await requireBuilt(rootDir);
    browser = await chromium.launch();
    const started = await startServerFor({ deckDir, prefix: "roundtrip-cmd-s" });
    try {
      const page = await openApp(browser, started.server);
      // startServerFor opens the file via registry.dispatch("open", { path: slidraPath }),
      // which always carries a sourcePath (see helpers/launch.ts's own notes),
      // so /api/save has something to write back to. Make a real edit first so
      // dirty becomes true — pressing Cmd+S without changing anything would
      // leave dirty: false regardless of whether Cmd+S did anything.
      const setResult = await started.registry.dispatch("text set", {
        id: started.presentationId,
        slidePath: "slides/001.svg",
        elementId: "el-title",
        newText: "Cmd+S test",
      });
      expect(setResult.ok).toBe(true);
      await expect
        .poll(() => fetch(`${started.server.url}/api/save-state`).then((r) => r.json()))
        .toEqual({ known: true, dirty: true, fileName: "deck.slidra" });

      // Focus is deliberately left on the parent document (no click into the
      // slide): the Cmd+S keydown listener is attached to App.tsx's
      // `document`, and if focus first moved into the sandbox iframe, this
      // key event would never bubble back to the parent document (events
      // don't bubble across iframe boundaries), so Cmd+S would never fire —
      // this verifies exactly the most directly reachable path, "focus in
      // the parent document".
      await page.keyboard.press("Meta+s");

      await expect
        .poll(() => fetch(`${started.server.url}/api/save-state`).then((r) => r.json()))
        .toEqual({ known: true, dirty: false, fileName: "deck.slidra" });
    } finally {
      await browser.close();
      await started.cleanup();
    }
  });
});
