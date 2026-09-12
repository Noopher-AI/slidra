import { describe, expect, it } from "vitest";
import { toExportUiState } from "../src/App.js";
import type { ExportSseEvent } from "../src/live-reload.js";

// toExportUiState 是「SSE export 事件 → ExportPanel props」唯一的轉換點。
// export-panel.test.ts 只測 ExportPanel(props) → markup，props 本身若在這裡被
// 蓋成固定值（例如永遠 0/0），元件測試照樣綠燈——這裡直接鎖住轉換本身
// (NOOP-110r4，重現方式與突變見票面描述)。
describe("toExportUiState（NOOP-110r4）", () => {
  it("progress 事件的 completedFrames/totalFrames 原樣傳給面板", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf-frames", state: "progress", completedFrames: 17, totalFrames: 45 };
    expect(toExportUiState(event)).toEqual({ kind: "busy", format: "pdf-frames", completedFrames: 17, totalFrames: 45 });
  });

  it("running 事件的 completedFrames/totalFrames 原樣傳給面板", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf", state: "running", completedFrames: 3, totalFrames: 10 };
    expect(toExportUiState(event)).toEqual({ kind: "busy", format: "pdf", completedFrames: 3, totalFrames: 10 });
  });

  it("queued 事件尚無格數，固定回傳 0/0", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf", state: "queued" };
    expect(toExportUiState(event)).toEqual({ kind: "busy", format: "pdf", completedFrames: 0, totalFrames: 0 });
  });

  it("done 事件轉成下載用的檔名/頁數/路徑", () => {
    const event: ExportSseEvent = {
      jobId: "j",
      format: "pdf-frames",
      state: "done",
      completedFrames: 45,
      totalFrames: 45,
      pageCount: 45,
      fileName: "簡報-frames.pdf",
      downloadPath: "/api/export/j/file",
    };
    expect(toExportUiState(event)).toEqual({ kind: "done", fileName: "簡報-frames.pdf", pageCount: 45, downloadPath: "/api/export/j/file" });
  });

  it("error 事件轉成錯誤訊息", () => {
    const event: ExportSseEvent = { jobId: "j", format: "pdf", state: "error", message: "渲染失敗" };
    expect(toExportUiState(event)).toEqual({ kind: "error", message: "渲染失敗" });
  });
});
