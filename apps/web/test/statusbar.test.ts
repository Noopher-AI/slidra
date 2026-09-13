// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBar, type StatusBarProps } from "../src/shell/StatusBar.js";
import type { CanvasState } from "../src/canvas.js";

// StatusBar's public boundary, like TitleBar's, is props → rendered string
// (the same convention titlebar.test.ts / export-panel.test.ts already use).
const state = {
  mode: "view",
  slides: [],
  currentIndex: 0,
  selection: { ids: [], names: [] },
  error: null,
} as unknown as CanvasState;

function markupFor(): string {
  const props: StatusBarProps = { state, controller: null };
  return renderToStaticMarkup(createElement(StatusBar, props));
}

describe("StatusBar bottom-right corner", () => {
  it("no settings gear: agent and model are now picked directly from the pill row below the chat box, so the status bar ends with the page-number section", () => {
    const markup = markupFor();
    expect(markup).not.toContain("status-settings-button");
    expect(markup).not.toContain('aria-label="Settings"');
    expect(markup.trimEnd().endsWith("</span></footer>")).toBe(true);
    expect(markup).toContain("status-page");
  });
});

// An e2e test can assert on whether the bar contains the string "Selected: 3
// elements" precisely because that's what the chip text looks like when
// multiple elements are selected — the sole source of truth for that
// contract is the selectionLabel computation here, which used to be guarded
// only by e2e. This pins it down at the cheapest possible layer: props →
// rendered string.
describe("StatusBar selection chip text", () => {
  function markupWithSelection(ids: string[], names: (string | null)[]): string {
    const selectedState = { ...state, selection: { ids, names } } as unknown as CanvasState;
    const props: StatusBarProps = { state: selectedState, controller: null };
    return renderToStaticMarkup(createElement(StatusBar, props));
  }

  it("nothing selected: the chip is empty, no \"Selected:\"", () => {
    const markup = markupWithSelection([], []);
    expect(markup).not.toContain("Selected:");
  });

  it("a single element is selected and has data-slidra-name: the chip shows that name, not the id", () => {
    const markup = markupWithSelection(["el-a"], ["Title"]);
    expect(markup).toContain("Selected:");
    expect(markup).toContain("Title");
    expect(markup).not.toContain("el-a");
  });

  it("a single element is selected but has no data-slidra-name: the chip falls back to showing the id", () => {
    const markup = markupWithSelection(["el-a"], [null]);
    expect(markup).toContain("Selected:");
    expect(markup).toContain("el-a");
  });

  it("multi-select (3 elements): the chip shows \"Selected: 3 elements\", the exact string an e2e test asserts on", () => {
    const markup = markupWithSelection(["el-a", "el-b", "el-c"], ["Title", null, "Subtitle"]);
    expect(markup).toContain("Selected:");
    expect(markup).toContain("3 elements");
  });
});
