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

// NOOP-349 round 3: F-15 B-2 之所以能用「bar 裡有沒有 "Selected: 3
// elements" 這串字」當斷言，是因為多選時 chip 的文字就長這樣——這條契約唯
// 一的來源是這裡的 selectionLabel 算式，之前只有 e2e 在守，這裡把它釘在
// 最便宜的 props → 渲染字串這一層。
describe("StatusBar 選取 chip 文字（NOOP-349 round 3）", () => {
  function markupWithSelection(ids: string[], names: (string | null)[]): string {
    const selectedState = { ...state, selection: { ids, names } } as unknown as CanvasState;
    const props: StatusBarProps = { state: selectedState, controller: null, settingsOpen: false, onOpenSettings: () => {} };
    return renderToStaticMarkup(createElement(StatusBar, props));
  }

  it("沒有選取任何東西：chip 是空的，不含 Selected:", () => {
    const markup = markupWithSelection([], []);
    expect(markup).not.toContain("Selected:");
  });

  it("選取單一元素且有 data-comot-name：chip 顯示該名稱，不是 id", () => {
    const markup = markupWithSelection(["el-a"], ["標題"]);
    expect(markup).toContain("Selected:");
    expect(markup).toContain("標題");
    expect(markup).not.toContain("el-a");
  });

  it("選取單一元素但沒有 data-comot-name：chip 退回顯示 id", () => {
    const markup = markupWithSelection(["el-a"], [null]);
    expect(markup).toContain("Selected:");
    expect(markup).toContain("el-a");
  });

  it("多選（3 個元素）：chip 顯示「Selected: 3 elements」，這是 F-15 B-2 唯一斷言的字串", () => {
    const markup = markupWithSelection(["el-a", "el-b", "el-c"], ["標題", null, "副標"]);
    expect(markup).toContain("Selected:");
    expect(markup).toContain("3 elements");
  });
});
