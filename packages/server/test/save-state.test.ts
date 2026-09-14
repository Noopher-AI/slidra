// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeBroadcaster } from "../src/changes.js";
import { EditingLock } from "../src/editing-lock.js";
import { writeProjectsRegistry } from "../src/slidra/home.js";

vi.mock("../src/slidra/command.js", () => ({ runJsonCommand: vi.fn() }));

import { runJsonCommand } from "../src/slidra/command.js";
import { createSaveController } from "../src/save-state.js";

const runJsonCommandMock = vi.mocked(runJsonCommand);

const ID = "P1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeBroadcaster(): ChangeBroadcaster {
  return {
    handleConnection: async () => {},
    broadcast: vi.fn(),
    dispose: async () => {},
    retarget: async () => {},
  };
}

describe("save-state.ts: createSaveController", () => {
  let home: string;
  let deckDir: string;
  let sourceDir: string;
  let deckPath: string;
  let sourcePath: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "slidra-savectl-home-"));
    deckDir = await mkdtemp(path.join(tmpdir(), "slidra-savectl-deck-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "slidra-savectl-source-"));
    deckPath = path.join(deckDir, "deck.slidra");
    sourcePath = path.join(sourceDir, "a.slidra");
    await writeFile(deckPath, "deck-bytes");
    await writeFile(sourcePath, "source-bytes");
    previousHome = process.env.SLIDRA_HOME;
    process.env.SLIDRA_HOME = home;
    // A clean baseline: savedAt matches the deck's own current mtime, so
    // `readSaveState`'s on-disk comparison starts at dirty:false — every
    // test below drives `dirty` purely through the controller's own
    // `pending` flag, never by touching the deck file's mtime.
    const savedAt = (await stat(deckPath)).mtimeMs;
    await writeProjectsRegistry(new Map([[ID, { deckPath, sourcePath, savedAt }]]));
    runJsonCommandMock.mockReset();
    runJsonCommandMock.mockResolvedValue({ ok: true, message: "ok" });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.SLIDRA_HOME;
    else process.env.SLIDRA_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(deckDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("AC6: a burst of 20 markDirty() calls 10ms apart collapses into a single write-back", async () => {
    const controller = createSaveController({
      presentationId: ID,
      broadcaster: fakeBroadcaster(),
      editingLock: new EditingLock(),
      debounceMs: 50,
      maxWaitMs: 5000,
    });
    for (let i = 0; i < 20; i++) {
      controller.markDirty();
      await sleep(10);
    }
    await sleep(120);
    expect(runJsonCommandMock).toHaveBeenCalledTimes(1);
    expect(runJsonCommandMock).toHaveBeenCalledWith(["pack", ID, sourcePath]);
  });

  it("a continuous burst longer than maxWaitMs forces at least one write-back despite the debounce never running out on its own", async () => {
    const controller = createSaveController({
      presentationId: ID,
      broadcaster: fakeBroadcaster(),
      editingLock: new EditingLock(),
      debounceMs: 100,
      maxWaitMs: 300,
    });
    // Each markDirty() resets the 100ms debounce — without the 300ms
    // max-wait cap, a save spaced this tightly would never fire.
    for (let i = 0; i < 8; i++) {
      controller.markDirty();
      await sleep(40);
    }
    await sleep(150);
    expect(runJsonCommandMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("defers a debounce tick that finds the editing floor held, and retries once it's idle", async () => {
    const lock = new EditingLock();
    lock.beginHumanEdit(); // simulates a live drag in progress
    const controller = createSaveController({
      presentationId: ID,
      broadcaster: fakeBroadcaster(),
      editingLock: lock,
      debounceMs: 30,
      maxWaitMs: 5000,
    });
    controller.markDirty();
    await sleep(90); // well past the debounce window — must not have fired
    expect(runJsonCommandMock).not.toHaveBeenCalled();

    lock.endHumanEdit();
    await sleep(250); // past the 200ms busy-retry interval
    expect(runJsonCommandMock).toHaveBeenCalledTimes(1);
  });

  it("never schedules a save when the entry has no sourcePath, and never errors", async () => {
    await writeProjectsRegistry(new Map([[ID, { deckPath }]]));
    const controller = createSaveController({
      presentationId: ID,
      broadcaster: fakeBroadcaster(),
      editingLock: new EditingLock(),
      debounceMs: 20,
      maxWaitMs: 5000,
    });
    controller.markDirty();
    await sleep(80);
    expect(runJsonCommandMock).not.toHaveBeenCalled();
    await expect(controller.state()).resolves.toEqual({ known: false });
  });

  it("classifies a write-back failure without leaking a real filesystem path, and recovers once the cause is removed (AC4)", async () => {
    const controller = createSaveController({
      presentationId: ID,
      broadcaster: fakeBroadcaster(),
      editingLock: new EditingLock(),
      debounceMs: 5000,
      maxWaitMs: 5000,
    });
    controller.markDirty();

    // ENOENT: the directory holding sourcePath disappears (the browser-
    // upload flow's staged copy living on a volume that gets unmounted).
    await rm(sourceDir, { recursive: true, force: true });
    const failed = await controller.flush();
    expect(failed).toMatchObject({ known: true, dirty: true, phase: "failed" });
    expect(failed.known && failed.reason).toContain("no longer available");
    expect(failed.known && failed.reason).not.toContain(sourceDir);
    expect(runJsonCommandMock).not.toHaveBeenCalled(); // the probe caught it before ever calling pack

    // Recovery: restore the directory, flush() succeeds.
    await mkdir(sourceDir, { recursive: true });
    const recovered = await controller.flush();
    expect(recovered).toEqual({ known: true, dirty: false, fileName: "a.slidra", phase: "saved" });
    expect(runJsonCommandMock).toHaveBeenCalledTimes(1);

    // EACCES: skipped under root, where chmod 0o500 does not actually
    // block a write (a false pass would look like coverage that isn't
    // there).
    if (process.getuid?.() === 0) return;
    controller.markDirty();
    await chmod(sourceDir, 0o500);
    try {
      const denied = await controller.flush();
      expect(denied).toMatchObject({ known: true, dirty: true, phase: "failed" });
      expect(denied.known && denied.reason).toContain("Permission denied");
      expect(denied.known && denied.reason).not.toContain(sourceDir);
    } finally {
      await chmod(sourceDir, 0o700);
    }
  });

  it("flush() cancels the pending debounce timer and writes back immediately", async () => {
    const controller = createSaveController({
      presentationId: ID,
      broadcaster: fakeBroadcaster(),
      editingLock: new EditingLock(),
      debounceMs: 5000,
      maxWaitMs: 5000,
    });
    controller.markDirty();
    const result = await controller.flush();
    expect(result).toEqual({ known: true, dirty: false, fileName: "a.slidra", phase: "saved" });
    expect(runJsonCommandMock).toHaveBeenCalledTimes(1);
    // No further write-back fires later — flush() already cancelled the timer.
    await sleep(80);
    expect(runJsonCommandMock).toHaveBeenCalledTimes(1);
  });

  it("dispose() writes back a still-pending edit before shutdown completes", async () => {
    const controller = createSaveController({
      presentationId: ID,
      broadcaster: fakeBroadcaster(),
      editingLock: new EditingLock(),
      debounceMs: 5000,
      maxWaitMs: 5000,
    });
    controller.markDirty();
    await controller.dispose();
    expect(runJsonCommandMock).toHaveBeenCalledTimes(1);
    await expect(controller.state()).resolves.toEqual({ known: true, dirty: false, fileName: "a.slidra", phase: "saved" });
  });
});
