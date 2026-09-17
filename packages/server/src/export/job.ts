// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { randomBytes } from "node:crypto";

export type ExportFormat = "pdf" | "pdf-frames";

/**
 * The wire shape of the `export` SSE event (NOOP-93 §4.4) and of what the
 * CLI prints — one state machine, one set of fields, both consumers read
 * from it rather than keeping their own copy.
 */
export type ExportEvent =
  | { jobId: string; format: ExportFormat; state: "queued" }
  | { jobId: string; format: ExportFormat; state: "running"; totalFrames: number; completedFrames: 0 }
  | { jobId: string; format: ExportFormat; state: "progress"; totalFrames: number; completedFrames: number }
  | {
      jobId: string;
      format: ExportFormat;
      state: "done";
      totalFrames: number;
      completedFrames: number;
      pageCount: number;
      fileName: string;
      downloadPath: string;
    }
  | { jobId: string; format: ExportFormat; state: "error"; message: string };

/** What `run()` (the actual rendering work — `render.ts`, injected so `export-job.test.ts` can supply a fake) hands back on success. */
export interface ExportRunResult {
  pageCount: number;
  fileName: string;
  /** A real filesystem path (ADR-0003) — never sent over the wire. `getFilePath` is the only way it leaves this module. */
  filePath: string;
}

export type ExportRunner = (
  /** The freshly-generated job id — `run` needs it to place its output under `<SLIDRA_HOME>/exports/<jobId>/` (§4.4), and it does not exist before `start()` generates it, so it is handed in rather than the caller having to invent its own id up front. */
  jobId: string,
  format: ExportFormat,
  onRunning: (totalFrames: number) => void,
  onProgress: (completedFrames: number, totalFrames: number) => void,
) => Promise<ExportRunResult>;

interface JobRecord {
  format: ExportFormat;
  state: ExportEvent["state"];
  totalFrames?: number;
  completedFrames?: number;
  filePath?: string;
}

/**
 * Owns the "only one export job at a time" gate and the state machine's
 * legal transitions (NOOP-93 §4.4): `queued → running → progress* → done`,
 * or `→ error` from any of those. `done`/`error` are terminal — no event is
 * ever sent for a `jobId` again after either.
 *
 * Every job this process has ever run stays in `jobs` for the rest of the
 * process's life (not just the currently-active one): `GET
 * /api/export/:jobId/file` must keep working for an older, already-`done`
 * job even after a second one has started and finished — this is not the
 * "history" §2 point 4 excludes (no UI lists past jobs, nothing lets an
 * author browse them), it is what makes the one download link `done`
 * hands out still resolve.
 */
export class ExportJobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private activeJobId: string | null = null;

  hasActiveJob(): boolean {
    return this.activeJobId !== null;
  }

  /** The real filesystem path for a `done` job, or `undefined` for an unknown or not-yet-done job — `serve.ts`'s `GET /api/export/:jobId/file` route turns the latter into 404 without distinguishing the two reasons (§4.4's table draws no distinction either). */
  getFilePath(jobId: string): string | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "done") return undefined;
    return job.filePath;
  }

  /**
   * Starts a new job: broadcasts `queued` synchronously, before returning
   * — "queued is broadcast before the 202 response" — then runs `run` in the
   * background, broadcasting `running`/`progress`/`done`/`error` as it
   * reports back. Throws synchronously (before anything is broadcast or
   * recorded) if a job is already active; the caller is expected to have
   * already checked `hasActiveJob()` for the 409 response, but this is the
   * actual gate — the check and this call happen inside the same
   * synchronous turn of the event loop, so nothing can race between them.
   */
  start(format: ExportFormat, broadcast: (event: ExportEvent) => void, run: ExportRunner): string {
    if (this.activeJobId !== null) {
      throw new Error("An export job is already in progress");
    }
    const jobId = randomBytes(9).toString("hex");
    this.activeJobId = jobId;
    this.jobs.set(jobId, { format, state: "queued" });
    broadcast({ jobId, format, state: "queued" });

    void this.runJob(jobId, format, broadcast, run);

    return jobId;
  }

  private async runJob(
    jobId: string,
    format: ExportFormat,
    broadcast: (event: ExportEvent) => void,
    run: ExportRunner,
  ): Promise<void> {
    try {
      const result = await run(
        jobId,
        format,
        (totalFrames) => {
          this.jobs.set(jobId, { format, state: "running", totalFrames, completedFrames: 0 });
          broadcast({ jobId, format, state: "running", totalFrames, completedFrames: 0 });
        },
        (completedFrames, totalFrames) => {
          this.jobs.set(jobId, { format, state: "progress", totalFrames, completedFrames });
          broadcast({ jobId, format, state: "progress", totalFrames, completedFrames });
        },
      );
      const record = this.jobs.get(jobId);
      const totalFrames = record?.totalFrames ?? result.pageCount;
      const completedFrames = record?.completedFrames ?? result.pageCount;
      this.jobs.set(jobId, { format, state: "done", totalFrames, completedFrames, filePath: result.filePath });
      broadcast({
        jobId,
        format,
        state: "done",
        totalFrames,
        completedFrames,
        pageCount: result.pageCount,
        fileName: result.fileName,
        downloadPath: `/api/export/${jobId}/file`,
      });
    } catch (error) {
      // ADR-0003: an export failure's message must never carry a real
      // filesystem path. Every error this job can actually throw already
      // comes from `renderExportPdf`'s own `SlidraError`s (path-free by
      // that class's own contract) or a plain Error with a message this
      // module never derives from a path itself, so relaying `.message`
      // verbatim holds that invariant rather than merely hoping callers do.
      const message = error instanceof Error ? error.message : "Export failed";
      this.jobs.set(jobId, { format, state: "error" });
      broadcast({ jobId, format, state: "error", message });
    } finally {
      this.activeJobId = null;
    }
  }
}
