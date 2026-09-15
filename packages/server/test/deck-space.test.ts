// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleDecksGet, handleResolvePost, handleThumbnailGet } from "../src/open-endpoint.js";
import { createLocalDeckStore, type DeckStore } from "../src/storage/deck-store.js";

/**
 * [E6.T4] plan §6's test inventory for Deck Space's new server surface:
 * `DeckListEntry.id`/`.lastModified`, `POST /api/deck/resolve`, and
 * `GET /api/decks/thumbnail`'s cache. Same discipline as
 * `deck-storage.test.ts` (unit level, real `slidra` binary, no browser).
 */

const execFileAsync = promisify(execFile);
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const slidraBinPath = path.join(rootDir, "target/release/slidra");

interface CliEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
  failureKind?: string;
}

async function runCli<T = unknown>(args: string[]): Promise<CliEnvelope<T>> {
  try {
    const { stdout } = await execFileAsync(slidraBinPath, [...args, "--json"], { env: process.env });
    return JSON.parse(stdout.trim()) as CliEnvelope<T>;
  } catch (error) {
    const err = error as { stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
      return JSON.parse(err.stdout.trim()) as CliEnvelope<T>;
    }
    throw error;
  }
}

let slidraHome: string;
let deckFolder: string;
let store: DeckStore;

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-deckspace-home-"));
  deckFolder = await mkdtemp(path.join(tmpdir(), "slidra-deckspace-folder-"));
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
  await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder }));
  store = createLocalDeckStore();
});

afterEach(async () => {
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(deckFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A `.slidra` file sitting in the deck folder that has never been `open`ed — `deck list` finds it, but no registry entry names it yet. Mirrors how a deck arrives on disk outside the GUI (copied in, synced from elsewhere). */
async function createUnregisteredDeck(fileName: string, name: string): Promise<string> {
  const targetPath = path.join(deckFolder, fileName);
  expect((await runCli(["new", targetPath, "--name", name])).ok).toBe(true);
  return targetPath;
}

/** A registered deck with one real slide, via `store.create` + `slide add` — what a thumbnail needs to render. */
async function createDeckWithSlide(name: string): Promise<{ id: string; fileName: string }> {
  const created = await store.create({ name });
  expect((await runCli(["slide", "add", created.id])).ok).toBe(true);
  return created;
}

describe("DeckStore.list — id/lastModified (AC2)", () => {
  it("reports id: null and a real lastModified for a deck that has never been opened", async () => {
    await createUnregisteredDeck("Untouched.slidra", "Untouched");
    const decks = await store.list();
    const entry = decks.find((d) => d.fileName === "Untouched.slidra");
    expect(entry?.id).toBeNull();
    expect(entry?.lastModified).toEqual(expect.any(Number));
    expect(entry!.lastModified).toBeGreaterThan(0);
  });

  it("reports the real registry id for a deck that has already been created/opened", async () => {
    const created = await store.create({ name: "Registered" });
    const decks = await store.list();
    const entry = decks.find((d) => d.fileName === "Registered.slidra");
    expect(entry?.id).toBe(created.id);
  });
});

describe("DeckStore.rename reflected in list (AC5)", () => {
  it("a renamed deck's new file name replaces the old one in the next listing", async () => {
    const created = await store.create({ name: "Old Name" });
    await store.rename(created.id, "New Name");

    const decks = await store.list();
    expect(decks.map((d) => d.fileName)).not.toContain("Old Name.slidra");
    const entry = decks.find((d) => d.fileName === "New Name.slidra");
    expect(entry?.id).toBe(created.id);
  });
});

function createDeckSpaceTestServer(deckStore: DeckStore): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/decks") {
        void handleDecksGet(deckStore, url, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/deck/resolve") {
        void handleResolvePost(deckStore, req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/decks/thumbnail") {
        void handleThumbnailGet(deckStore, url, req, res);
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("POST /api/deck/resolve", () => {
  let testServer: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    testServer = await createDeckSpaceTestServer(store);
  });

  afterEach(async () => {
    await testServer.close();
  });

  it.each([
    ["missing fileName", {}],
    ["empty fileName", { fileName: "" }],
    ["non-string fileName", { fileName: 42 }],
    ["a fileName containing a path separator", { fileName: "sub/dir.slidra" }],
    ["a fileName containing '..'", { fileName: "../escape.slidra" }],
  ])("400s on %s", async (_label, body) => {
    const response = await fetch(`${testServer.url}/api/deck/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  });

  it("404s for a file name the deck folder does not have", async () => {
    const response = await fetch(`${testServer.url}/api/deck/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "NoSuchFile.slidra" }),
    });
    expect(response.status).toBe(404);
  });

  it("registers a never-opened deck exactly once and is idempotent on repeat calls", async () => {
    await createUnregisteredDeck("Lazy.slidra", "Lazy");

    const first = await fetch(`${testServer.url}/api/deck/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "Lazy.slidra" }),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { id: string; fileName: string };
    expect(firstJson.fileName).toBe("Lazy.slidra");
    expect(firstJson.id).toBeTruthy();

    const second = await fetch(`${testServer.url}/api/deck/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "Lazy.slidra" }),
    });
    const secondJson = (await second.json()) as { id: string; fileName: string };
    expect(secondJson.id).toBe(firstJson.id);
  });
});

describe("GET /api/decks/thumbnail (AC2/AC6)", () => {
  let testServer: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    testServer = await createDeckSpaceTestServer(store);
  });

  afterEach(async () => {
    await testServer.close();
  });

  it("400s on a missing/invalid fileName query param", async () => {
    const response = await fetch(`${testServer.url}/api/decks/thumbnail`);
    expect(response.status).toBe(400);
  });

  it("404s for a file name the deck folder does not have", async () => {
    const response = await fetch(`${testServer.url}/api/decks/thumbnail?fileName=Missing.slidra`);
    expect(response.status).toBe(404);
  });

  it("204s for a deck with no slides", async () => {
    await createUnregisteredDeck("Empty.slidra", "Empty");
    const response = await fetch(`${testServer.url}/api/decks/thumbnail?fileName=Empty.slidra`);
    expect(response.status).toBe(204);
  });

  it("renders an SVG on first request, and is not regenerated on the second (cache hit)", async () => {
    const { fileName } = await createDeckWithSlide("Thumbed");

    const first = await fetch(`${testServer.url}/api/decks/thumbnail?fileName=${fileName}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("image/svg+xml");
    const firstBytes = Buffer.from(await first.arrayBuffer());
    expect(firstBytes.byteLength).toBeGreaterThan(0);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const cacheDir = path.join(slidraHome, "thumbnails");
    const cacheFiles = await readdir(cacheDir);
    expect(cacheFiles).toHaveLength(1);
    const cachePath = path.join(cacheDir, cacheFiles[0]!);
    const statBeforeSecondRequest = await stat(cachePath);

    const second = await fetch(`${testServer.url}/api/decks/thumbnail?fileName=${fileName}`);
    expect(second.status).toBe(200);
    const secondBytes = Buffer.from(await second.arrayBuffer());
    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(second.headers.get("etag")).toBe(etag);

    const statAfterSecondRequest = await stat(cachePath);
    expect(statAfterSecondRequest.mtimeMs).toBe(statBeforeSecondRequest.mtimeMs);
  });

  it("304s when If-None-Match matches the current ETag", async () => {
    const { fileName } = await createDeckWithSlide("Etagged");
    const first = await fetch(`${testServer.url}/api/decks/thumbnail?fileName=${fileName}`);
    const etag = first.headers.get("etag")!;

    const conditional = await fetch(`${testServer.url}/api/decks/thumbnail?fileName=${fileName}`, {
      headers: { "If-None-Match": etag },
    });
    expect(conditional.status).toBe(304);
  });
});
