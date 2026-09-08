import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBar, type StatusBarProps } from "../src/shell/StatusBar.js";
import type { CanvasState } from "../src/canvas.js";

// StatusBar 的公開邊界跟 TitleBar 一樣是 props → 渲染出的字串
// （titlebar.test.ts / export-panel.test.ts 同一個慣例）。
const state = {
  mode: "view",
  slides: [],
  currentIndex: 0,
  selection: { ids: [], names: [] },
  error: null,
} as unknown as CanvasState;

function markupFor(settingsOpen: boolean): string {
  const props: StatusBarProps = { state, controller: null, settingsOpen, onOpenSettings: () => {} };
  return renderToStaticMarkup(createElement(StatusBar, props));
}

describe("StatusBar 齒輪鈕（[E3.T5] Plan §4.9）", () => {
  it("渲染帶正確 aria 屬性的齒輪鈕，settingsOpen 反映在 aria-expanded 上", () => {
    const markup = markupFor(true);
    expect(markup).toContain("status-settings-button");
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="true"');
  });

  it("齒輪鈕排在頁碼區之後，也就是狀態列（畫面右下角）的最後一個元素", () => {
    const markup = markupFor(false);
    expect(markup.indexOf("status-settings-button")).toBeGreaterThan(markup.indexOf("status-page"));
    expect(markup).toContain('aria-expanded="false"');
  });
});
