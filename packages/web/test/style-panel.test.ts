import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseSlide, type SlideElement } from "../src/slide-dom.js";
import type { CanvasState } from "../src/canvas.js";
import { StyleObjectPanel } from "../src/shell/side/StyleObjectPanel.js";

/**
 * #200 §3.3/§6.1: public-boundary test for the segmented Style › Object
 * panel — `renderToStaticMarkup`, same convention `stage-overlays.test.ts`/
 * `animate-panel.test.ts` already use for a presentational component.
 * Command-sending behaviour (what `onCommit` actually does) is exercised
 * end to end in `e2e/style-panel.test.ts`; this file only covers what a
 * given `CanvasState.selection` renders as.
 */

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
  '<g id="el-a"><rect x="0" y="0" width="10" height="10" fill="#111"/></g>' +
  '<g id="el-b"><rect x="0" y="0" width="10" height="10" fill="#222"/></g>' +
  '<g id="el-text" data-comot-text-width="300"><text font-size="24" xml:space="preserve"><tspan x="0" y="24">Hi</tspan></text></g>' +
  '<g id="el-group"><g id="el-group-child"><rect x="0" y="0" width="10" height="10"/></g></g>' +
  "</svg>";

function elementOf(id: string): SlideElement {
  const model = parseSlide(SVG);
  const found = model.elements.find((element) => element.id === id);
  if (!found) throw new Error(`fixture 裡沒有 id=${id} 的元素`);
  return found;
}

function stateFor(ids: string[]): CanvasState {
  const elements = ids.map((id) => elementOf(id));
  return {
    slides: ["slides/001.svg"],
    currentIndex: 0,
    mode: "view",
    playerHasFocus: false,
    error: null,
    selection: { ids, names: ids.map(() => null), groupPath: [], elements },
    dragSignal: 0,
    pageStyle: { background: null, accent: null },
  };
}

function render(state: CanvasState): string {
  return renderToStaticMarkup(createElement(StyleObjectPanel, { state, controller: null }));
}

describe("StyleObjectPanel（#200 §4.1/§4.6）", () => {
  it("空選取：空狀態提示，不渲染任何欄位", () => {
    const markup = render(stateFor([]));
    expect(markup).toContain("選取元素以檢視樣式");
    expect(markup).not.toContain("style-field");
  });

  it("選到群組：全部欄位 disabled，且顯示群組提示，不渲染 Text/Shape 段", () => {
    const markup = render(stateFor(["el-group"]));
    expect(markup).toContain("群組沒有可套用樣式的圖元");
    expect(markup).not.toContain('data-section="text"');
    expect(markup).not.toContain('data-section="shape"');
    // Appearance 一律顯示，但欄位要是 disabled 的。
    expect(markup).toContain('data-section="appearance"');
    expect(markup).toMatch(/data-attr="opacity"[^>]*disabled/);
  });

  it("形狀元素：Shape 段的欄位現值全部 unset（沒設過 stroke），data-state 與 placeholder 一致", () => {
    const markup = render(stateFor(["el-a"]));
    expect(markup).toContain('data-section="shape"');
    expect(markup).toMatch(/data-attr="stroke" data-state="unset"[^>]*placeholder="未設定"/);
  });

  it("兩個形狀 fill 不同：mixed，data-state 與 placeholder 一致", () => {
    const markup = render(stateFor(["el-a", "el-b"]));
    expect(markup).toMatch(/data-attr="fill" data-state="mixed"[^>]*placeholder="不一致"/);
  });

  it("混合型別選取（文字＋形狀）：只顯示 Appearance 與骨架段，附提示，不顯示 Text/Shape", () => {
    const markup = render(stateFor(["el-text", "el-a"]));
    expect(markup).toContain("選取包含多種元素型別，只顯示共同屬性");
    expect(markup).not.toContain('data-section="text"');
    expect(markup).not.toContain('data-section="shape"');
    expect(markup).toContain('data-section="appearance"');
  });

  it("骨架段（Table／Chart）一律渲染，且每個控制項都是 disabled", () => {
    const markup = render(stateFor(["el-a"]));
    expect(markup).toContain('data-section="table"');
    expect(markup).toContain('data-section="chart"');
    const tableSection = markup.slice(markup.indexOf('data-section="table"'), markup.indexOf('data-section="chart"'));
    const chartSection = markup.slice(markup.indexOf('data-section="chart"'));
    for (const section of [tableSection, chartSection]) {
      const controls = [...section.matchAll(/<(select|input)[^>]*>/g)];
      expect(controls.length).toBeGreaterThan(0);
      for (const [tag] of controls) {
        expect(tag).toContain("disabled");
      }
    }
  });
});
