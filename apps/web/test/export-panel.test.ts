import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportPanel, type ExportUiState } from "../src/shell/ExportPanel.js";

// ExportPanel's public boundary is props → rendered string (same
// convention as icons.test.ts). e2e can only guarantee "the value shown on
// screen is one of the ones carried by an event" — "running" already
// carries completedFrames: 0, so a broken implementation that always
// prints 0/N would still pass e2e. This test rules that out with no timing
// dependency at all.
function markupFor(state: ExportUiState): string {
  return renderToStaticMarkup(
    createElement(ExportPanel, { open: false, onToggle: () => {}, onClose: () => {}, onPick: () => {}, canExport: true, state, onDismiss: () => {} }),
  );
}

describe("ExportPanel progress text", () => {
  it("renders the completedFrames/totalFrames given via props while busy, not a fixed value", () => {
    for (const [completedFrames, totalFrames] of [[0, 45], [17, 45], [45, 45]] as const) {
      const markup = markupFor({ kind: "busy", format: "pdf-frames", completedFrames, totalFrames });
      expect(markup).toContain(`匯出中… ${completedFrames}/${totalFrames}`);
    }
  });

  it("renders the exporting-status text without numbers when totalFrames is 0 (queued, no frame count yet)", () => {
    const markup = markupFor({ kind: "busy", format: "pdf", completedFrames: 0, totalFrames: 0 });
    expect(markup).toContain(`<div class="export-status" role="status">匯出中…</div>`);
    expect(markup).not.toContain("0/0");
  });

  it("renders a download link when done, text formatted the same way e2e asserts on it", () => {
    const markup = markupFor({ kind: "done", fileName: "簡報-frames.pdf", pageCount: 45, downloadPath: "/api/export/abc/file" });
    expect(markup).toContain("下載 簡報-frames.pdf（45 頁）");
    expect(markup).toContain('href="/api/export/abc/file"');
  });
});
