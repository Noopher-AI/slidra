import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNewPresentation, openPresentation, readPresentationFile, setElementText } from "../src/workspace.js";
import { SLIDE_FILE_NAME } from "../src/presentation.js";
import { watchPresentation } from "../src/watch.js";
import type { PresentationWatcher } from "../src/watch.js";

// Every test points CO_MOTION_HOME at its own temp directory (ADR-0004
// testing convention), the same as workspace.test.ts. Changes are always
// made through the real write path (`setElementText`, the same function
// the `text set` command dispatches to) — never a direct write to the
// work directory's real path.
let coMotionHome: string;
let comotDir: string;
let watchers: PresentationWatcher[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-watch-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-watch-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  watchers = [];
});

afterEach(async () => {
  // Always close every watcher, including on assertion failure, or a
  // pending debounce timer (unref'd, but still an open fs.watch handle)
  // lingers past the test.
  await Promise.all(watchers.map((watcher) => watcher.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

async function watch(id: string, onChange: () => void): Promise<PresentationWatcher> {
  const watcher = await watchPresentation(id, onChange);
  watchers.push(watcher);
  return watcher;
}

async function openFreshPresentation(name = "測試簡報"): Promise<{ id: string; elementId: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await createNewPresentation(comotPath, name);
  const { id } = await openPresentation(comotPath);
  const svg = await readPresentationFile(id, SLIDE_FILE_NAME);
  const match = svg.match(/<text id="([^"]+)"/);
  if (!match) {
    throw new Error("test fixture is missing the expected <text id=…> element");
  }
  return { id, elementId: match[1] };
}

describe("watchPresentation", () => {
  it("notifies when a slide file is modified externally through the real write path", async () => {
    const { id, elementId } = await openFreshPresentation();
    let resolveNotified!: () => void;
    const notified = new Promise<void>((resolve) => {
      resolveNotified = resolve;
    });
    await watch(id, resolveNotified);

    await setElementText(id, SLIDE_FILE_NAME, elementId, "改過的標題");

    await notified;
  });

  it("delivers a notification for each of several sequential modifications, awaiting between them", async () => {
    // Asserts only that each modification is eventually observed, never how
    // many raw events fired — the debounce window is timing, not behaviour.
    const { id, elementId } = await openFreshPresentation();
    let resolvePending: (() => void) | null = null;
    await watch(id, () => resolvePending?.());

    for (const text of ["第一次修改", "第二次修改", "第三次修改"]) {
      const waitForChange = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      await setElementText(id, SLIDE_FILE_NAME, elementId, text);
      await waitForChange;
    }
  });

  it("rejects with the same wording an unknown presentation id already produces on a real read", async () => {
    await expect(watchPresentation("does-not-exist", () => {})).rejects.toThrow(/找不到識別碼對應的簡報/);
    await expect(readPresentationFile("does-not-exist", SLIDE_FILE_NAME)).rejects.toThrow(
      /找不到識別碼對應的簡報/,
    );
  });

  it("close() stops further notifications", async () => {
    const { id, elementId } = await openFreshPresentation();
    let callCount = 0;
    const watcher = await watch(id, () => {
      callCount += 1;
    });

    await watcher.close();
    await setElementText(id, SLIDE_FILE_NAME, elementId, "after close");
    // Give any in-flight fs event a moment to (wrongly) arrive.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(callCount).toBe(0);
  });
});
