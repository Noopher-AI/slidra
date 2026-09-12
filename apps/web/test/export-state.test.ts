import { describe, expect, it } from "vitest";
import { toExportUiState } from "../src/App.js";
import type { ExportSseEvent } from "../src/live-reload.js";

// toExportUiState is the single conversion point from "SSE export event" to
// "ExportPanel props". export-panel.test.ts only tests ExportPanel(props) →
// markup; if the props themselves got hardcoded to fixed values here (e.g.
// always 0/0), the component test would still pass — this file locks down
// the conversion itself.
describe("toExportUiState", () => {
  it("a progress event's completedFrames/totalFrames pass through to the panel unchanged", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf-frames", state: "progress", completedFrames: 17, totalFrames: 45 };
    expect(toExportUiState(event)).toEqual({ kind: "busy", format: "pdf-frames", completedFrames: 17, totalFrames: 45 });
  });

  it("a running event's completedFrames/totalFrames pass through to the panel unchanged", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf", state: "running", completedFrames: 3, totalFrames: 10 };
    expect(toExportUiState(event)).toEqual({ kind: "busy", format: "pdf", completedFrames: 3, totalFrames: 10 });
  });

  it("a queued event has no frame counts yet, so it returns a fixed 0/0", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf", state: "queued" };
    expect(toExportUiState(event)).toEqual({ kind: "busy", format: "pdf", completedFrames: 0, totalFrames: 0 });
  });

  it("a done event converts into the download filename/page count/path", () => {
    const event: ExportSseEvent = {
      jobId: "j",
      format: "pdf-frames",
      state: "done",
      completedFrames: 45,
      totalFrames: 45,
      pageCount: 45,
      fileName: "deck-frames.pdf",
      downloadPath: "/api/export/j/file",
    };
    expect(toExportUiState(event)).toEqual({ kind: "done", fileName: "deck-frames.pdf", pageCount: 45, downloadPath: "/api/export/j/file" });
  });

  it("an error event converts into an error message", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf", state: "error", message: "Render failed" };
    expect(toExportUiState(event)).toEqual({ kind: "error", message: "Render failed" });
  });
});
