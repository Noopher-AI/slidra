// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { packDirectory } from "./helpers/pack.js";
import { requireBuilt } from "./helpers/launch.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";

/**
 * Deck Space's own browser-level coverage ([E6.T4] plan §6 — the one new
 * e2e file this ticket is authorized to open, 4 tests: AC1, AC3, AC4, and
 * AC5+AC7 together). Everything a unit/HTTP test can already cover
 * (`packages/server/test/deck-space.test.ts`, `packages/web/test/*`) is
 * deliberately not repeated here — this file only exercises what needs a
 * real browser + a real server with no deck open: the startup screen
 * itself, entering a deck from it, and the title bar's own Deck Space
 * button.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const fixtureDeckDir = path.join(rootDir, "e2e/fixtures/plain-text-deck");

const execFileAsync = promisify(execFile);

async function runCli(args: string[]): Promise<void> {
  const { stdout } = await execFileAsync(slidraBin, [...args, "--json"], { env: process.env });
  const parsed = JSON.parse(stdout.trim()) as { ok: boolean; message: string };
  if (!parsed.ok) throw new Error(`slidra ${args.join(" ")} failed: ${parsed.message}`);
}

interface DeckSpaceHarness {
  server: RunningServer;
  deckFolder: string;
  cleanup(): Promise<void>;
}

/** A real server started with NO presentation id — `serve`'s "no deck open" startup state (AC1), the one this whole file exists to cover. */
async function startDeckSpaceServer(prefix: string): Promise<DeckSpaceHarness> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), `slidra-e2e-${prefix}-home-`));
  const deckFolder = await mkdtemp(path.join(tmpdir(), `slidra-e2e-${prefix}-deckfolder-`));
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBin;
  await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder }));

  const server = await startServe({ port: 0 });

  return {
    server,
    deckFolder,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(deckFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/**
 * Packs `fixtureDeckDir` into the deck folder under `fileName`, then gives
 * it `displayName` (`deck meta set`) so multiple seeded decks — every one a
 * copy of the same fixture, which would otherwise all share its literal
 * `project.json` name — are distinguishable in the grid by more than file
 * name alone. `open` first is what migrates the fixture's legacy container
 * to the current format (plan §4's "legacy ZIP" null-entry only applies to
 * a deck nobody has opened yet — not the scenario these tests want); the
 * resulting registry entry is harmless here; card behaviour with a
 * genuinely never-opened (`id: null`) entry is already covered by
 * `packages/server/test/deck-space.test.ts`.
 */
async function seedDeck(deckFolder: string, fileName: string, displayName: string): Promise<void> {
  const targetPath = path.join(deckFolder, fileName);
  await packDirectory(fixtureDeckDir, targetPath);
  await runCli(["open", targetPath]);
  await runCli(["deck", "meta", "set", targetPath, "--name", displayName]);
}

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

async function openPage(server: RunningServer, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  openPages.push(page);
  await page.goto(server.url);
  await expect.poll(() => page.locator(".deck-space").count(), { timeout: 30_000 }).toBeGreaterThan(0);
  return page;
}

describe("① starting with no deck open lands on Deck Space (AC1)", () => {
  it("renders .deck-space, mounts no editor shell, and lists the deck folder's own file as a card", async () => {
    const harness = await startDeckSpaceServer("ac1");
    try {
      await seedDeck(harness.deckFolder, "Untouched.slidra", "Untouched Deck");
      const page = await openPage(harness.server);

      expect(await page.locator(".titlebar").count()).toBe(0);
      await expect.poll(() => page.locator(".deck-card").count(), { timeout: 10_000 }).toBe(1);
      expect(await page.locator(".deck-card-name").first().textContent()).toBe("Untouched Deck");
      // [E6.T14r2] AC6②: the user block mounts on the Deck Space startup
      // screen itself, not only once a deck is open.
      expect(await page.locator(".user-block").count()).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("② clicking a card enters that deck (AC3)", () => {
  it("switches to the clicked deck and the editor shows its own content", async () => {
    const harness = await startDeckSpaceServer("ac3");
    try {
      await seedDeck(harness.deckFolder, "ClickMe.slidra", "Click Me Deck");
      const page = await openPage(harness.server);

      await page.locator(".deck-card").first().click();
      await expect.poll(() => page.locator(".titlebar").count(), { timeout: 10_000 }).toBeGreaterThan(0);
      expect(await page.locator(".deck-space").count()).toBe(0);

      const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").filter({ hasText: "Plain text" });
      await expect.poll(() => slideText.count().catch(() => 0), { timeout: 10_000 }).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("③ new deck, open external file, rename, and delete are all reachable and do what they say (AC4)", () => {
  it("new deck enters a fresh deck; open external enters the uploaded one; rename/delete act on the right card", async () => {
    const harness = await startDeckSpaceServer("ac4");
    try {
      await seedDeck(harness.deckFolder, "ToRename.slidra", "Deck To Rename");
      const page = await openPage(harness.server);

      // New deck: creates and immediately enters a brand-new deck.
      await page.getByRole("button", { name: "New deck" }).click();
      await expect.poll(() => page.locator(".titlebar").count(), { timeout: 10_000 }).toBeGreaterThan(0);

      // Back to Deck Space, then open an external file via the hidden input
      // (the same upload path the drag-and-drop zone posts through).
      await page.getByRole("button", { name: "Deck Space" }).click();
      await expect.poll(() => page.locator(".deck-space").count(), { timeout: 10_000 }).toBeGreaterThan(0);

      const otherDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ac4-external-"));
      try {
        const externalPath = path.join(otherDir, "External.slidra");
        await packDirectory(fixtureDeckDir, externalPath);
        await page.locator(".deck-space-file-input").setInputFiles(externalPath);
        await expect.poll(() => page.locator(".titlebar").count(), { timeout: 10_000 }).toBeGreaterThan(0);
      } finally {
        await rm(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }

      // Back to Deck Space to rename and delete the untouched seed deck
      // (never the two decks just entered above — renaming/deleting the
      // currently-bound deck is refused, AC4's own edge case).
      await page.getByRole("button", { name: "Deck Space" }).click();
      await expect.poll(() => page.locator(".deck-card").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

      const targetCard = page.locator(".deck-card").filter({ hasText: "Deck To Rename" });
      await targetCard.getByRole("button", { name: "Rename" }).click();
      // Not `targetCard.locator(...)` from here on: entering edit mode
      // replaces the card's name text with an `<input>` (its value, not
      // text content), so a `hasText`-filtered locator stops resolving to
      // this same card the instant editing starts. Only one card can be
      // mid-edit at a time, so an unscoped lookup for the input/Save button
      // is still unambiguous.
      await page.locator(".deck-card-rename-input").fill("Renamed Deck");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => page.locator(".deck-card-name", { hasText: "Renamed Deck" }).count(), { timeout: 10_000 }).toBe(1);

      const renamedCard = page.locator(".deck-card").filter({ hasText: "Renamed Deck" });
      await renamedCard.getByRole("button", { name: "Delete" }).click();
      await renamedCard.getByRole("button", { name: "Confirm delete" }).click();
      await expect.poll(() => page.locator(".deck-card-name", { hasText: "Renamed Deck" }).count(), { timeout: 10_000 }).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("④ title bar has no New/Open/Save (AC5) and Deck Space is usable at 1280x720 (AC7)", () => {
  it("shows the Deck Space button (never New/Open/Save) once inside a deck, and the four action buttons plus the first card fit with no horizontal scroll", async () => {
    const harness = await startDeckSpaceServer("ac5-ac7");
    try {
      await seedDeck(harness.deckFolder, "Narrow.slidra", "Narrow Viewport Deck");
      const page = await openPage(harness.server, { width: 1280, height: 720 });

      await page.locator(".deck-card").first().click();
      await expect.poll(() => page.locator(".titlebar").count(), { timeout: 10_000 }).toBeGreaterThan(0);

      expect(await page.locator('.titlebar-button[title="New"]').count()).toBe(0);
      expect(await page.locator('.titlebar-button[title="Open…"]').count()).toBe(0);
      expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Deck Space" }).isVisible()).toBe(true);

      await page.getByRole("button", { name: "Deck Space" }).click();
      await expect.poll(() => page.locator(".deck-space").count(), { timeout: 10_000 }).toBeGreaterThan(0);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      expect(overflow).toBe(true);

      expect(await page.getByRole("button", { name: "New deck" }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Open file" }).isVisible()).toBe(true);
      const firstCard = page.locator(".deck-card").first();
      expect(await firstCard.isVisible()).toBe(true);
      expect(await firstCard.getByRole("button", { name: "Rename" }).isVisible()).toBe(true);
      expect(await firstCard.getByRole("button", { name: "Delete" }).isVisible()).toBe(true);

      const gridColumns = await page.locator(".deck-space-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns);
      // jsdom-free real layout: however many tracks fit, each must be
      // exactly what `repeat(auto-fill, minmax(220px, 1fr))` produces —
      // every resolved column width at or above the 220px floor.
      const widths = gridColumns.split(" ").map((token) => parseFloat(token));
      expect(widths.length).toBeGreaterThan(0);
      for (const width of widths) expect(width).toBeGreaterThanOrEqual(220 - 1);
    } finally {
      await harness.cleanup();
    }
  });
});
