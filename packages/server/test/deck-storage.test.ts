// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleOpenPost } from "../src/open-endpoint.js";
import { readProjectsRegistry } from "../src/slidra/home.js";
import { resolveDeckFolder } from "../src/storage/deck-folder.js";
import {
  DeckBoundError,
  DeckNameConflictError,
  ImportConfirmationRequiredError,
  createLocalDeckStore,
  type DeckStore,
} from "../src/storage/deck-store.js";

/**
 * Unit-level (`node` layer) coverage for `storage/` and its two callers
 * ([E6.T2] plan §6's test inventory): no browser, real `slidra` binary
 * (same discipline as `deck-switch.test.ts`). Also absorbs two cases
 * `e2e/file-roundtrip.test.ts`'s old `POST /api/open` describe block used
 * to cover at the e2e layer ("400s on a corrupt upload" / "400s on an
 * empty body") — neither needs a browser or a full `startServe`, only
 * `handleOpenPost` itself.
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

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-deckstorage-home-"));
  deckFolder = await mkdtemp(path.join(tmpdir(), "slidra-deckstorage-folder-"));
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
});

afterEach(async () => {
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(deckFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Points `deckFolder` (this test file's own key) at `folder` via `settings.json` — the one way `resolveDeckFolder` is configured. */
async function setDeckFolder(folder: string): Promise<void> {
  await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder: folder }));
}

describe("resolveDeckFolder (folder resolution)", () => {
  it("defaults to ~/Slidra when settings.json has no deckFolder key at all (including a missing file)", async () => {
    await expect(resolveDeckFolder()).resolves.toBe(path.join(homedir(), "Slidra"));
  });

  it("rejects an explicit empty string rather than silently falling back to the default", async () => {
    await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder: "" }));
    await expect(resolveDeckFolder()).rejects.toThrow(/non-empty string/);
  });

  it("rejects a wrongly-typed value rather than coercing it", async () => {
    await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder: 123 }));
    await expect(resolveDeckFolder()).rejects.toThrow(/non-empty string/);
  });
});

describe("DeckStore.create", () => {
  let store: DeckStore;

  beforeEach(async () => {
    await setDeckFolder(deckFolder);
    store = createLocalDeckStore();
  });

  it("lands the new deck in the deck folder with no confirmation of any kind (AC1)", async () => {
    const created = await store.create({ name: "Q3" });
    expect(created.fileName).toBe("Q3.slidra");
    expect(created.id).toBeTruthy();
    await expect(stat(path.join(deckFolder, "Q3.slidra"))).resolves.toBeTruthy();
  });

  it("avoids a filename conflict by appending -1, -2, ... rather than overwriting", async () => {
    const first = await store.create({ name: "Q3" });
    const second = await store.create({ name: "Q3" });
    expect(first.fileName).toBe("Q3.slidra");
    expect(second.fileName).toBe("Q3-1.slidra");
  });

  it("sanitizes a name of only '..' into underscores rather than accepting it as a path fragment", async () => {
    const created = await store.create({ name: ".." });
    expect(created.fileName).toBe("__.slidra");
    await expect(stat(path.join(deckFolder, "__.slidra"))).resolves.toBeTruthy();
  });
});

describe("DeckStore.importExternal", () => {
  let store: DeckStore;
  let externalDir: string;

  beforeEach(async () => {
    await setDeckFolder(deckFolder);
    store = createLocalDeckStore();
    externalDir = await mkdtemp(path.join(tmpdir(), "slidra-deckstorage-external-"));
  });

  afterEach(async () => {
    await rm(externalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("registers a sourcePath already inside the deck folder directly — no move, no copy, no confirmation", async () => {
    const insidePath = path.join(deckFolder, "already-here.slidra");
    expect((await runCli(["new", insidePath, "--name", "Already Here"])).ok).toBe(true);

    const result = await store.importExternal({ sourcePath: insidePath });
    expect(result.fileName).toBe("already-here.slidra");
    await expect(stat(insidePath)).resolves.toBeTruthy();
  });

  it("throws ImportConfirmationRequiredError naming the sourcePath when outside the folder with no disposition, touching nothing", async () => {
    const externalPath = path.join(externalDir, "external.slidra");
    expect((await runCli(["new", externalPath, "--name", "External"])).ok).toBe(true);

    await expect(store.importExternal({ sourcePath: externalPath })).rejects.toSatisfy(
      (error: unknown) => error instanceof ImportConfirmationRequiredError && error.sourcePath === path.resolve(externalPath),
    );
    await expect(stat(externalPath)).resolves.toBeTruthy();
    await expect(readdir(deckFolder)).resolves.toEqual([]);
  });

  it('disposition "move": the source no longer exists afterward', async () => {
    const externalPath = path.join(externalDir, "moveme.slidra");
    expect((await runCli(["new", externalPath, "--name", "Move Me"])).ok).toBe(true);

    const result = await store.importExternal({ sourcePath: externalPath, disposition: "move" });
    expect(result.fileName).toBe("moveme.slidra");
    await expect(stat(externalPath)).rejects.toThrow();
    await expect(stat(path.join(deckFolder, "moveme.slidra"))).resolves.toBeTruthy();
  });

  it('disposition "copy": the source is left in place', async () => {
    const externalPath = path.join(externalDir, "copyme.slidra");
    expect((await runCli(["new", externalPath, "--name", "Copy Me"])).ok).toBe(true);

    const result = await store.importExternal({ sourcePath: externalPath, disposition: "copy" });
    expect(result.fileName).toBe("copyme.slidra");
    await expect(stat(externalPath)).resolves.toBeTruthy();
    await expect(stat(path.join(deckFolder, "copyme.slidra"))).resolves.toBeTruthy();
  });
});

describe("DeckStore.remove", () => {
  let store: DeckStore;
  let xdgDataHome: string;

  beforeEach(async () => {
    await setDeckFolder(deckFolder);
    xdgDataHome = await mkdtemp(path.join(tmpdir(), "slidra-deckstorage-xdg-"));
    process.env.XDG_DATA_HOME = xdgDataHome;
    store = createLocalDeckStore();
  });

  afterEach(async () => {
    delete process.env.XDG_DATA_HOME;
    await rm(xdgDataHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.skipIf(process.platform !== "linux")(
    "moves the deleted deck into the XDG trash with a correct .trashinfo, and drops the registry entry (AC4, Linux)",
    async () => {
      const created = await store.create({ name: "ToDelete" });
      const deckPath = path.join(deckFolder, "ToDelete.slidra");

      await store.remove(created.id);

      await expect(stat(deckPath)).rejects.toThrow();
      await expect(stat(path.join(xdgDataHome, "Trash", "files", "ToDelete.slidra"))).resolves.toBeTruthy();
      const info = await readFile(path.join(xdgDataHome, "Trash", "info", "ToDelete.slidra.trashinfo"), "utf8");
      expect(info).toContain("[Trash Info]");
      expect(info).toContain(`Path=${encodeURI(deckPath)}`);

      const registry = await readProjectsRegistry();
      expect(registry.has(created.id)).toBe(false);
    },
  );

  it("refuses to delete the currently-bound deck (DeckBoundError), touching nothing", async () => {
    const created = await store.create({ name: "Bound" });
    const boundStore = createLocalDeckStore({ getCurrentDeckId: () => created.id });

    await expect(boundStore.remove(created.id)).rejects.toBeInstanceOf(DeckBoundError);
    await expect(stat(path.join(deckFolder, "Bound.slidra"))).resolves.toBeTruthy();
    const registry = await readProjectsRegistry();
    expect(registry.has(created.id)).toBe(true);
  });
});

describe("DeckStore.rename", () => {
  let store: DeckStore;

  beforeEach(async () => {
    await setDeckFolder(deckFolder);
    store = createLocalDeckStore();
  });

  it("renames the file on disk, updates the registry's deckPath, and syncs project.json's display name (AC5)", async () => {
    const created = await store.create({ name: "Original" });
    await store.rename(created.id, "Renamed");

    await expect(stat(path.join(deckFolder, "Original.slidra"))).rejects.toThrow();
    await expect(stat(path.join(deckFolder, "Renamed.slidra"))).resolves.toBeTruthy();

    const registry = await readProjectsRegistry();
    expect(registry.get(created.id)?.deckPath).toBe(path.join(deckFolder, "Renamed.slidra"));

    const decks = await store.list();
    const entry = decks.find((d) => d.fileName === "Renamed.slidra");
    expect(entry?.name).toBe("Renamed");
  });

  it("refuses a rename onto an existing filename (DeckNameConflictError), auto-avoiding nothing", async () => {
    const a = await store.create({ name: "A" });
    await store.create({ name: "B" });

    await expect(store.rename(a.id, "B")).rejects.toBeInstanceOf(DeckNameConflictError);
    await expect(stat(path.join(deckFolder, "A.slidra"))).resolves.toBeTruthy();
  });
});

function createOpenEndpointTestServer(store: DeckStore): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleOpenPost(store, req, res);
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

describe("POST /api/open (merged from e2e/file-roundtrip.test.ts)", () => {
  let store: DeckStore;
  let testServer: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    await setDeckFolder(deckFolder);
    store = createLocalDeckStore();
    testServer = await createOpenEndpointTestServer(store);
  });

  afterEach(async () => {
    await testServer.close();
  });

  it("400s on a corrupt upload, leaving no file behind in the deck folder", async () => {
    const response = await fetch(testServer.url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-slidra-file-name": "broken.slidra" },
      body: Buffer.from("not a zip file"),
    });
    expect(response.status).toBe(400);
    await expect(readdir(deckFolder)).resolves.toEqual([]);
  });

  it("400s on an empty body with the existing wording", async () => {
    const response = await fetch(testServer.url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(0),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("No file content received");
  });
});
