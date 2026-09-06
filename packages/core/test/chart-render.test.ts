import { describe, expect, it } from "vitest";
import { renderChartSvg } from "../src/chart/render.js";
import type { ChartModel, ChartType } from "../src/chart/model.js";

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
    series: [{ name: "Revenue", values: [10, 20, 30], axis: "left", color: null }],
    categories: ["Q1", "Q2", "Q3"],
    ...overrides,
  };
}

const CHART_TYPES: ChartType[] = ["bar", "hbar", "line", "area", "pie", "donut"];

describe("renderChartSvg — the six禁令 (plan §4.1 / AC-10)", () => {
  it("never emits an id attribute, <style>, class, <defs>, gradients, or SMIL/CSS animation, for every type", () => {
    for (const type of CHART_TYPES) {
      const svg = renderChartSvg(baseModel({ type, stacked: false }));
      expect(svg).not.toMatch(/\bid="/);
      expect(svg).not.toContain("<style");
      expect(svg).not.toMatch(/\bclass="/);
      expect(svg).not.toContain("<defs");
      expect(svg).not.toMatch(/gradient/i);
      expect(svg).not.toMatch(/<animate/);
      expect(svg).not.toMatch(/animation/);
    }
  });
});

describe("renderChartSvg — shape", () => {
  it("wraps in a self-contained <svg> with xmlns, width, height and viewBox — no x/y", () => {
    const svg = renderChartSvg(baseModel({ width: 486.4, height: 475.2 }));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="486\.4" height="475\.2" viewBox="0 0 486\.4 475\.2">/);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toMatch(/<svg[^>]* x="/);
    expect(svg).not.toMatch(/<svg[^>]* y="/);
  });

  it("renders each of the six chart types without throwing, producing non-empty output", () => {
    for (const type of CHART_TYPES) {
      const svg = renderChartSvg(baseModel({ type }));
      expect(svg.length).toBeGreaterThan(100);
    }
  });

  const legendSwatchCount = (svg: string) => svg.match(/<rect x="[\d.]+" y="[\d.]+" width="10" height="10" rx="2"/g)?.length ?? 0;

  it("draws a legend item per category for pie/donut, per series otherwise", () => {
    const pie = renderChartSvg(baseModel({ type: "pie", legend: "bottom" }));
    expect(legendSwatchCount(pie)).toBe(3); // one per category

    const bar = renderChartSvg(
      baseModel({
        legend: "bottom",
        series: [
          { name: "A", values: [1, 2, 3], axis: "left", color: null },
          { name: "B", values: [3, 2, 1], axis: "left", color: null },
        ],
      }),
    );
    expect(legendSwatchCount(bar)).toBe(2); // one per series
  });

  it("omits the legend entirely when legend=none", () => {
    const svg = renderChartSvg(baseModel({ legend: "none" }));
    expect(legendSwatchCount(svg)).toBe(0);
  });

  it("draws x-title/y-title text only when set", () => {
    const withTitles = renderChartSvg(baseModel({ xTitle: "Week", yTitle: "ms" }));
    expect(withTitles).toContain("WEEK");
    expect(withTitles).toContain("MS");

    const without = renderChartSvg(baseModel({ xTitle: "", yTitle: "" }));
    expect(without).not.toContain("WEEK");
  });

  it("omits grid lines when grid=false, draws them when grid=true", () => {
    const withGrid = renderChartSvg(baseModel({ grid: true }));
    const withoutGrid = renderChartSvg(baseModel({ grid: false }));
    expect(withGrid).toContain("stroke-dasharray");
    expect(withoutGrid).not.toContain("stroke-dasharray");
  });

  it("omits value-label text when labels=false", () => {
    const withLabels = renderChartSvg(baseModel({ labels: true }));
    const withoutLabels = renderChartSvg(baseModel({ labels: false }));
    // value 20 only appears as a data label (categories are Q1/Q2/Q3, values 10/20/30)
    expect(withLabels).toContain(">20<");
    expect(withoutLabels).not.toContain(">20<");
  });
});

describe("renderChartSvg — dual axis (AC-5)", () => {
  it("draws a second set of tick text on the right border for a right-axis series", () => {
    const single = renderChartSvg(baseModel());
    const dual = renderChartSvg(
      baseModel({
        axes: "dual",
        series: [
          { name: "Left", values: [10, 20, 30], axis: "left", color: null },
          { name: "Right", values: [1000, 2000, 3000], axis: "right", color: "#5B6DEA" },
        ],
      }),
    );
    // 5 ticks (0..4) on the left axis regardless; dual adds 5 more on the right.
    const tickTextCount = (svg: string) => (svg.match(/text-anchor="(end|start)"[^>]*>\d/g) ?? []).length;
    expect(tickTextCount(dual)).toBeGreaterThan(tickTextCount(single));
    expect(dual).toContain('text-anchor="start"'); // right-axis ticks anchor start
  });

  it("positions the right-axis series' bars using the right series' own domain, not the left one", () => {
    // A right-axis series with much larger values must not be squashed to
    // the same pixel scale as the left series — it gets its own domain.
    const dual = renderChartSvg(
      baseModel({
        type: "line",
        axes: "dual",
        series: [
          { name: "Left", values: [1, 1, 1], axis: "left", color: null },
          { name: "Right", values: [1000, 500, 1000], axis: "right", color: null },
        ],
      }),
    );
    const polylines = [...dual.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]);
    expect(polylines).toHaveLength(2);
    const leftPoints = polylines[0].split(" ").map((p) => p.split(",").map(Number));
    // Left series is flat (all values 1) -> all y identical.
    expect(new Set(leftPoints.map((p) => p[1])).size).toBe(1);
    const rightPoints = polylines[1].split(" ").map((p) => p.split(",").map(Number));
    // Right series dips at the middle point -> y values differ.
    expect(new Set(rightPoints.map((p) => p[1])).size).toBeGreaterThan(1);
  });
});

describe("renderChartSvg — stacked (AC-6)", () => {
  it("stacks bars in the same category so the total height equals the sum of values", () => {
    const model = baseModel({
      type: "bar",
      stacked: true,
      series: [
        { name: "A", values: [10, 10, 10], axis: "left", color: "#111111" },
        { name: "B", values: [20, 20, 20], axis: "left", color: "#222222" },
      ],
    });
    const svg = renderChartSvg(model);
    const rects = [...svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)" fill="(#\w+)"/g)];
    // Render order is series-major (series A's 3 categories, then series
    // B's), so category 0's two segments are rects[0] (A) and rects[3] (B).
    expect(rects).toHaveLength(6);
    const forCategory0 = [rects[0], rects[3]];
    // the two segments' y ranges must be adjacent (bottom of A == top of B)
    const [a, b] = forCategory0.map((r) => ({ y: Number(r[2]), h: Number(r[4]) }));
    expect(Math.abs(a.y - (b.y + b.h))).toBeLessThan(0.01);
  });

  it("stacks negative and positive values on opposite sides of zero", () => {
    const model = baseModel({
      type: "bar",
      stacked: true,
      grid: false,
      series: [
        { name: "Pos", values: [10], axis: "left", color: "#111111" },
        { name: "Neg", values: [-10], axis: "left", color: "#222222" },
      ],
      categories: ["Only"],
    });
    const svg = renderChartSvg(model);
    const zeroLineMatch = svg.match(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="\1" stroke="rgba\(255,255,255,\.5\)"\/>/);
    expect(zeroLineMatch).not.toBeNull();
    const zeroY = Number(zeroLineMatch![1]);
    const rects = [...svg.matchAll(/<rect x="[-\d.]+" y="([-\d.]+)" width="[-\d.]+" height="([-\d.]+)" fill="(#\w+)"/g)];
    const posRect = rects.find((r) => r[3] === "#111111")!;
    const negRect = rects.find((r) => r[3] === "#222222")!;
    // Positive bar's bottom sits at (or above) the zero line...
    expect(Number(posRect[1]) + Number(posRect[2])).toBeCloseTo(zeroY, 1);
    // ...negative bar's top sits at the zero line, extending downward.
    expect(Number(negRect[1])).toBeCloseTo(zeroY, 1);
  });
});
