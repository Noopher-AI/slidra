import { describe, expect, it } from "vitest";
import { ExportJobManager, type ExportEvent, type ExportRunner } from "../src/export/job.js";

/** Resolves once `run` has been awaited past its first `onRunning` call, without finishing the job — lets a test synchronize on "the job has started" before asserting on state mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ExportJobManager (NOOP-93 §4.4)", () => {
  it("runs the full queued -> running -> progress* -> done sequence with the right payloads", async () => {
    const events: ExportEvent[] = [];
    const manager = new ExportJobManager();
    const run: ExportRunner = async (_jobId, format, onRunning, onProgress) => {
      expect(format).toBe("pdf-frames");
      // A real renderer (render.ts) always awaits a browser launch/navigate
      // before its first onRunning() call — yielding at least once here is
      // what makes this fake behave like that instead of like a run() that
      // (having no internal await at all) would otherwise execute every
      // callback synchronously inside this very `start()` call.
      await Promise.resolve();
      onRunning(3);
      onProgress(1, 3);
      onProgress(2, 3);
      onProgress(3, 3);
      return { pageCount: 3, fileName: "deck-frames.pdf", filePath: "/tmp/whatever/deck-frames.pdf" };
    };

    const jobId = manager.start("pdf-frames", (event) => events.push(event), run);
    // start() only returns once the synchronous "queued" broadcast already
    // happened — §4.4's "queued 在 202 回應之前廣播".
    expect(events).toEqual([{ jobId, format: "pdf-frames", state: "queued" }]);

    // Let the fire-and-forget async work inside start() run to completion.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([
      { jobId, format: "pdf-frames", state: "queued" },
      { jobId, format: "pdf-frames", state: "running", totalFrames: 3, completedFrames: 0 },
      { jobId, format: "pdf-frames", state: "progress", totalFrames: 3, completedFrames: 1 },
      { jobId, format: "pdf-frames", state: "progress", totalFrames: 3, completedFrames: 2 },
      { jobId, format: "pdf-frames", state: "progress", totalFrames: 3, completedFrames: 3 },
      {
        jobId,
        format: "pdf-frames",
        state: "done",
        totalFrames: 3,
        completedFrames: 3,
        pageCount: 3,
        fileName: "deck-frames.pdf",
        downloadPath: `/api/export/${jobId}/file`,
      },
    ]);
    expect(manager.hasActiveJob()).toBe(false);
    expect(manager.getFilePath(jobId)).toBe("/tmp/whatever/deck-frames.pdf");
  });

  it("broadcasts error and clears the active slot when run() rejects", async () => {
    const events: ExportEvent[] = [];
    const manager = new ExportJobManager();
    const run: ExportRunner = async (_jobId, _format, onRunning) => {
      onRunning(2);
      throw new Error("模擬的匯出失敗");
    };

    const jobId = manager.start("pdf", (event) => events.push(event), run);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([
      { jobId, format: "pdf", state: "queued" },
      { jobId, format: "pdf", state: "running", totalFrames: 2, completedFrames: 0 },
      { jobId, format: "pdf", state: "error", message: "模擬的匯出失敗" },
    ]);
    expect(manager.hasActiveJob()).toBe(false);
    expect(manager.getFilePath(jobId)).toBeUndefined();
  });

  it("a second job while the first is still active throws synchronously — the 409 gate", async () => {
    const manager = new ExportJobManager();
    const gate = deferred<void>();
    const run: ExportRunner = async (_jobId, _format, onRunning) => {
      onRunning(1);
      await gate.promise;
      return { pageCount: 1, fileName: "a.pdf", filePath: "/tmp/a.pdf" };
    };

    manager.start("pdf", () => {}, run);
    expect(manager.hasActiveJob()).toBe(true);

    expect(() => manager.start("pdf-frames", () => {}, run)).toThrow("已有匯出工作進行中");

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.hasActiveJob()).toBe(false);
  });

  it("a job can start once the previous one has finished", async () => {
    const manager = new ExportJobManager();
    const events: ExportEvent[] = [];
    const run: ExportRunner = async (_jobId, format, onRunning) => {
      onRunning(1);
      return { pageCount: 1, fileName: `${format}.pdf`, filePath: `/tmp/${format}.pdf` };
    };

    const firstId = manager.start("pdf", (event) => events.push(event), run);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.hasActiveJob()).toBe(false);

    const secondId = manager.start("pdf-frames", (event) => events.push(event), run);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstId).not.toBe(secondId);
    expect(manager.getFilePath(firstId)).toBe("/tmp/pdf.pdf");
    expect(manager.getFilePath(secondId)).toBe("/tmp/pdf-frames.pdf");
  });

  it("no event is ever sent for a jobId again after done", async () => {
    const events: ExportEvent[] = [];
    const manager = new ExportJobManager();
    const run: ExportRunner = async () => ({ pageCount: 1, fileName: "a.pdf", filePath: "/tmp/a.pdf" });

    const jobId = manager.start("pdf", (event) => events.push(event), run);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const countAfterDone = events.length;

    // Nothing else touches this jobId again — no further broadcast, no
    // further state change, ever.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(countAfterDone);
    expect(events.at(-1)).toMatchObject({ jobId, state: "done" });
  });
});
