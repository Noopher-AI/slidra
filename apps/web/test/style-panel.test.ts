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
  '<g id="el-text" data-slidra-text-width="300"><text font-size="24" xml:space="preserve"><tspan x="0" y="24">Hi</tspan></text></g>' +
  '<g id="el-group"><g id="el-group-child"><rect x="0" y="0" width="10" height="10"/></g></g>' +
  "</svg>";

function elementOf(id: string): SlideElement {
  const model = parseSlide(SVG);
  const found = model.elements.find((element) => element.id === id);
  if (!found) throw new Error(`fixture has no element with id=${id}`);
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
    backgroundImage: null,
  };
}

function render(state: CanvasState): string {
  return renderToStaticMarkup(createElement(StyleObjectPanel, { state, controller: null }));
}

describe("StyleObjectPanel", () => {
  it("empty selection: shows the empty-state hint, renders no fields", () => {
    const markup = render(stateFor([]));
    expect(markup).toContain("Select an element to view its style");
    expect(markup).not.toContain("style-field");
  });

  it("a group is selected: all fields disabled, shows the group hint, doesn't render the Text/Shape sections", () => {
    const markup = render(stateFor(["el-group"]));
    expect(markup).toContain("Groups have no elements to apply style to");
    expect(markup).not.toContain('data-section="text"');
    expect(markup).not.toContain('data-section="shape"');
    // Appearance is always shown, but its fields must be disabled.
    expect(markup).toContain('data-section="appearance"');
    expect(markup).toMatch(/data-attr="opacity"[^>]*disabled/);
  });

  it("a shape element: every field in the Shape section is unset (stroke never set), data-state and placeholder agree", () => {
    const markup = render(stateFor(["el-a"]));
    expect(markup).toContain('data-section="shape"');
    expect(markup).toMatch(/data-attr="stroke" data-state="unset"[^>]*placeholder="Unset"/);
  });

  it("two shapes with different fill: mixed, data-state and placeholder agree", () => {
    const markup = render(stateFor(["el-a", "el-b"]));
    expect(markup).toMatch(/data-attr="fill" data-state="mixed"[^>]*placeholder="Mixed"/);
  });

  it("a mixed-type selection (text + shape): shows only Appearance and the skeleton sections with a hint, hides Text/Shape", () => {
    const markup = render(stateFor(["el-text", "el-a"]));
    expect(markup).toContain("Selection mixes multiple element types; only shared properties are shown");
    expect(markup).not.toContain('data-section="text"');
    expect(markup).not.toContain('data-section="shape"');
    expect(markup).toContain('data-section="appearance"');
  });

  it("the skeleton sections (Table/Chart) are always rendered, and every control in them is disabled", () => {
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
