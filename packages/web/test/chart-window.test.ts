import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartWindow, chartDataSetInputFromDraft } from "../src/shell/stage-overlays/ChartWindow.js";
import type { ChartWindowState } from "../src/canvas.js";
import type { ChartModel } from "@co-motion/core/chart";

/**
 * E2.T12 plan §6.2/§6.4: `chartDataSetInputFromDraft` (the "資料格 state →
 * chart data set input" conversion, pulled out of the JSX for the same
 * reason `TextPanel.tsx`'s own `textPanelInsertInput` is — this codebase's
 * React component tests are `renderToStaticMarkup` only, no
 * testing-library, so an interactive behaviour can only be unit tested by
 * extracting the computation) plus a `renderToStaticMarkup` smoke test of
 * `ChartWindow` itself, plus AC-12's DOMParser regression (§3.2 of the
 * plan: an unbound `<comot:chart>` produces a `parsererror` when the front
 * end's effects parser reads the WHOLE slide document).
 */

describe("chartDataSetInputFromDraft", () => {
  it("parses a valid draft into numeric values", () => {
    const result = chartDataSetInputFromDraft(
      ["Q1", "Q2"],
      [{ name: "Revenue", values: ["120", "150"] }],
    );
    expect(result).toEqual({ categories: ["Q1", "Q2"], series: [{ name: "Revenue", values: [120, 150] }] });
  });

  it("returns null for an empty category name (mid-edit, not yet sendable)", () => {
    expect(chartDataSetInputFromDraft(["Q1", ""], [{ name: "Revenue", values: ["120", "150"] }])).toBeNull();
  });

  it("returns null for an empty series name", () => {
    expect(chartDataSetInputFromDraft(["Q1"], [{ name: "", values: ["120"] }])).toBeNull();
  });

  it("returns null for a non-numeric value", () => {
    expect(chartDataSetInputFromDraft(["Q1"], [{ name: "Revenue", values: ["abc"] }])).toBeNull();
  });

  it("returns null (not zero) for an empty value string — a field mid-clear-and-retype, not a literal 0", () => {
    expect(chartDataSetInputFromDraft(["Q1"], [{ name: "Revenue", values: [""] }])).toBeNull();
  });

  it("returns null when a series' value count does not match the category count", () => {
    expect(chartDataSetInputFromDraft(["Q1", "Q2"], [{ name: "Revenue", values: ["120"] }])).toBeNull();
  });

  it("returns null with zero series or zero categories", () => {
    expect(chartDataSetInputFromDraft([], [{ name: "Revenue", values: [] }])).toBeNull();
    expect(chartDataSetInputFromDraft(["Q1"], [])).toBeNull();
  });
});

function baseModel(overrides: Partial<ChartModel> = {}): ChartModel {
  return {
    type: "bar",
    stacked: false,
    axes: "single",
    palette: "brand",
    legend: "bottom",
    grid: true,
    labels: true,
    xTitle: "",
    yTitle: "",
    width: 480,
    height: 300,
    series: [{ name: "Revenue", values: [120, 150, 170], axis: "left", color: null }],
    categories: ["Q1", "Q2", "Q3"],
    ...overrides,
  };
}

function windowState(model: ChartModel): ChartWindowState {
  return { id: "el-chart", slidePath: "slides/001.svg", model };
}

describe("ChartWindow — renderToStaticMarkup (AC-2/AC-3/AC-4/AC-5/AC-6の靜態結構)", () => {
  it("渲染 role=dialog、標題列、六個類型按鈕，目前類型 aria-pressed=true", () => {
    const markup = renderToStaticMarkup(
      createElement(ChartWindow, { state: windowState(baseModel()), controller: null, bounds: { width: 1000, height: 700 } }),
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Chart data");
    for (const label of ["Bar", "H-Bar", "Line", "Area", "Pie", "Donut"]) expect(markup).toContain(label);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Bar</);
  });

  it("資料表格：類別數列 × 系列數欄，每格帶目前的值", () => {
    const markup = renderToStaticMarkup(
      createElement(ChartWindow, { state: windowState(baseModel()), controller: null, bounds: { width: 1000, height: 700 } }),
    );
    expect((markup.match(/<tr>/g) ?? []).length).toBe(1 + 3); // 1 header row + 3 category rows
    expect(markup).toContain('value="120"');
    expect(markup).toContain('value="Revenue"');
  });

  it("pie 類型：不顯示 + Series、堆疊、雙軸、X/Y 軸標題控制", () => {
    const markup = renderToStaticMarkup(
      createElement(ChartWindow, { state: windowState(baseModel({ type: "pie", axes: "single" })), controller: null, bounds: { width: 1000, height: 700 } }),
    );
    expect(markup).not.toContain("Stacked");
    expect(markup).not.toContain("Dual axis");
    expect(markup).not.toContain("X axis title");
    expect(markup).toContain("Pie uses the first series");
  });

  it("非堆疊型別（line）：Stacked 開關 disabled；可堆疊型別（bar）：Stacked 開關可用", () => {
    const lineMarkup = renderToStaticMarkup(
      createElement(ChartWindow, { state: windowState(baseModel({ type: "line" })), controller: null, bounds: { width: 1000, height: 700 } }),
    );
    expect(lineMarkup).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/>\s*Stacked/);

    const barMarkup = renderToStaticMarkup(
      createElement(ChartWindow, { state: windowState(baseModel({ type: "bar" })), controller: null, bounds: { width: 1000, height: 700 } }),
    );
    expect(barMarkup).not.toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/>\s*Stacked/);
  });

  it("dual 軸：顯示每個系列的「→ right」指派勾選框，含目前哪個系列在右軸", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ChartWindow,
        {
          state: windowState(
            baseModel({
              axes: "dual",
              series: [
                { name: "Left", values: [1, 2, 3], axis: "left", color: null },
                { name: "Right", values: [4, 5, 6], axis: "right", color: null },
              ],
            }),
          ),
          controller: null,
          bounds: { width: 1000, height: 700 },
        },
      ),
    );
    expect(markup).toContain("Left → right");
    expect(markup).toContain("Right → right");
    expect(markup).toMatch(/checked=""[^>]*\/>\s*Right → right/);
  });
});

describe("AC-12: a slide containing a chart parses without a DOMParser parsererror", () => {
  it("含 <comot:chart>（帶 xmlns:comot）與內嵌 <svg> 的投影片，DOMParser 解析出 svg 根節點、無 parsererror", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">` +
      `<g id="el-chart" data-comot-type="chart" transform="translate(100 50)">` +
      `<comot:chart xmlns:comot="https://co-motion.dev/ns" type="bar" stacked="false" axes="single" ` +
      `palette="brand" legend="bottom" grid="true" labels="true" x-title="" y-title="" width="480" height="300">` +
      `<comot:series name="Revenue" values="120,150,170" axis="left"/>` +
      `<comot:categories values="Q1,Q2,Q3"/>` +
      `</comot:chart>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><rect width="1" height="1"/></svg>` +
      `</g></svg>`;
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    expect(doc.documentElement.tagName).toBe("svg");
  });
});
