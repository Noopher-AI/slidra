import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportPanel, type ExportUiState } from "../src/shell/ExportPanel.js";

// ExportPanel 的公開邊界是 props → 渲染出的字串（icons.test.ts 同一個慣例）。
// e2e 只能保證「畫面顯示的值是事件帶過的某一個」——running 本來就帶
// completedFrames: 0，所以一個永遠印 0/N 的壞實作在 e2e 是合法的。這裡用
// 沒有任何時序的方式把它擋掉。
function markupFor(state: ExportUiState): string {
  return renderToStaticMarkup(
    createElement(ExportPanel, { open: false, onToggle: () => {}, onClose: () => {}, onPick: () => {}, canExport: true, state, onDismiss: () => {} }),
  );
}

describe("ExportPanel 進度文字（NOOP-104 §4.B）", () => {
  it("busy 時渲染的是 props 給的 completedFrames/totalFrames，不是固定值", () => {
    for (const [completedFrames, totalFrames] of [[0, 45], [17, 45], [45, 45]] as const) {
      const markup = markupFor({ kind: "busy", format: "pdf-frames", completedFrames, totalFrames });
      expect(markup).toContain(`匯出中… ${completedFrames}/${totalFrames}`);
    }
  });

  it("totalFrames 為 0（queued，尚無格數）時渲染不帶數字的匯出中…", () => {
    const markup = markupFor({ kind: "busy", format: "pdf", completedFrames: 0, totalFrames: 0 });
    expect(markup).toContain(`<div class="export-status" role="status">匯出中…</div>`);
    expect(markup).not.toContain("0/0");
  });

  it("done 時渲染下載連結，文字與 e2e §4.A(5) 斷言的格式一致", () => {
    const markup = markupFor({ kind: "done", fileName: "簡報-frames.pdf", pageCount: 45, downloadPath: "/api/export/abc/file" });
    expect(markup).toContain("下載 簡報-frames.pdf（45 頁）");
    expect(markup).toContain('href="/api/export/abc/file"');
  });
});
