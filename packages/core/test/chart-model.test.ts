import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  readChartModel,
  serializeChartData,
  validateChartModel,
  type ChartModel,
} from "../src/chart/model.js";

const wrap = (chartMarkup: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">` +
  `<g id="el-chart" data-comot-type="chart">${chartMarkup}<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"></svg></g>` +
  `</svg>`;

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
    series: [{ name: "Revenue", values: [1, 2, 3], axis: "left", color: null }],
    categories: ["Q1", "Q2", "Q3"],
    ...overrides,
  };
}

describe("readChartModel / serializeChartData round-trip", () => {
  it("reads back exactly what was serialized", () => {
    const model = baseModel({
      series: [
        { name: "Revenue", values: [120, 150, 170], axis: "left", color: null },
        { name: "Cost", values: [80, 90, 95], axis: "right", color: "#5B6DEA" },
      ],
      axes: "dual",
      xTitle: "Week",
      yTitle: "ms",
    });
    const svg = wrap(serializeChartData(model));
    expect(readChartModel(svg, "el-chart")).toEqual(model);
  });

  it("throws 找不到元素 for a missing element id", () => {
    const svg = wrap(serializeChartData(baseModel()));
    expect(() => readChartModel(svg, "el-nope")).toThrow("找不到元素：el-nope");
  });

  it("throws 不是圖表 for an element id that exists but is not a chart", () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">` +
      `<g id="el-a"><rect width="1" height="1"/></g></svg>`;
    expect(() => readChartModel(svg, "el-a")).toThrow("元素 el-a 不是圖表");
  });

  it("tolerates axis=right under axes=single on read, but validateChartModel rejects it fresh", () => {
    const legacy = wrap(
      '<comot:chart xmlns:comot="https://co-motion.dev/ns" type="bar" stacked="false" axes="single" ' +
        'palette="brand" legend="bottom" grid="true" labels="true" x-title="" y-title="" width="480" height="300">' +
        '<comot:series name="A" values="1,2,3" axis="right"/>' +
        '<comot:categories values="Q1,Q2,Q3"/></comot:chart>',
    );
    const model = readChartModel(legacy, "el-chart");
    expect(model.series[0].axis).toBe("right");

    expect(() =>
      validateChartModel(baseModel({ series: [{ name: "A", values: [1, 2, 3], axis: "right", color: null }] })),
    ).toThrow(/axes 是 single/);
  });
});

describe("validateChartModel — boundary table (plan §4.4)", () => {
  it("accepts the minimum and maximum category counts, rejects one below/above", () => {
    expect(() =>
      validateChartModel(baseModel({ categories: ["A", "B"], series: [{ name: "S", values: [1, 2], axis: "left", color: null }] })),
    ).not.toThrow();
    const sixty = Array.from({ length: 60 }, (_, i) => `C${i}`);
    expect(() =>
      validateChartModel(baseModel({ categories: sixty, series: [{ name: "S", values: sixty.map(() => 1), axis: "left", color: null }] })),
    ).not.toThrow();
    expect(() =>
      validateChartModel(baseModel({ categories: ["A"], series: [{ name: "S", values: [1], axis: "left", color: null }] })),
    ).toThrow(/類別數/);
    const sixtyOne = Array.from({ length: 61 }, (_, i) => `C${i}`);
    expect(() =>
      validateChartModel(baseModel({ categories: sixtyOne, series: [{ name: "S", values: sixtyOne.map(() => 1), axis: "left", color: null }] })),
    ).toThrow(/類別數/);
  });

  it("accepts 1 and 12 series, rejects 0 and 13", () => {
    const cats = ["A", "B"];
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, values: [1, 2], axis: "left" as const, color: null }));
    expect(() => validateChartModel(baseModel({ categories: cats, series: many }))).not.toThrow();
    const tooMany = [...many, { name: "S12", values: [1, 2], axis: "left" as const, color: null }];
    expect(() => validateChartModel(baseModel({ categories: cats, series: tooMany }))).toThrow(/系列數/);
    expect(() => validateChartModel(baseModel({ categories: cats, series: [] }))).toThrow(/系列數/);
  });

  it("rejects a series whose value count does not match the category count", () => {
    expect(() =>
      validateChartModel(baseModel({ categories: ["A", "B"], series: [{ name: "S", values: [1], axis: "left", color: null }] })),
    ).toThrow(/值數（1）與類別數（2）不符/);
  });

  it("rejects a non-finite value, naming the series", () => {
    expect(() =>
      validateChartModel(baseModel({ series: [{ name: "S", values: [1, NaN, 3], axis: "left", color: null }] })),
    ).toThrow(/S.*第 2 個值/);
  });

  it("rejects a duplicate series name", () => {
    expect(() =>
      validateChartModel(
        baseModel({
          series: [
            { name: "A", values: [1, 2, 3], axis: "left", color: null },
            { name: "A", values: [4, 5, 6], axis: "left", color: null },
          ],
        }),
      ),
    ).toThrow("系列名稱重複：A");
  });

  it("rejects a series colour that is not #RGB or #RRGGBB", () => {
    for (const bad of ["red", "rgb(1,2,3)", "#12", "#1234567"]) {
      expect(() =>
        validateChartModel(baseModel({ series: [{ name: "S", values: [1, 2, 3], axis: "left", color: bad }] })),
      ).toThrow(/顏色/);
    }
    expect(() =>
      validateChartModel(baseModel({ series: [{ name: "S", values: [1, 2, 3], axis: "left", color: "#ABC" }] })),
    ).not.toThrow();
  });

  it("rejects width/height that are not positive finite numbers", () => {
    expect(() => validateChartModel(baseModel({ width: 0 }))).toThrow(/width/);
    expect(() => validateChartModel(baseModel({ width: -1 }))).toThrow(/width/);
    expect(() => validateChartModel(baseModel({ height: Infinity }))).toThrow(/height/);
  });

  it("allows every value to be zero", () => {
    expect(() =>
      validateChartModel(baseModel({ series: [{ name: "S", values: [0, 0, 0], axis: "left", color: null }] })),
    ).not.toThrow();
  });

  it("allows negative values", () => {
    expect(() =>
      validateChartModel(baseModel({ series: [{ name: "S", values: [-5, 2, 3], axis: "left", color: null }] })),
    ).not.toThrow();
  });

  it("rejects stacked=true for a non-stackable type", () => {
    expect(() => validateChartModel(baseModel({ type: "line", stacked: true }))).toThrow(/不支援堆疊/);
    expect(() => validateChartModel(baseModel({ type: "bar", stacked: true }))).not.toThrow();
  });

  it("rejects stacked=true combined with axes=dual", () => {
    expect(() =>
      validateChartModel(
        baseModel({
          type: "bar",
          stacked: true,
          axes: "dual",
          series: [{ name: "S", values: [1, 2, 3], axis: "right", color: null }],
        }),
      ),
    ).toThrow(/axes=single/);
  });

  it("rejects axes=dual for pie/donut", () => {
    expect(() =>
      validateChartModel(
        baseModel({ type: "pie", axes: "dual", series: [{ name: "S", values: [1, 2, 3], axis: "right", color: null }] }),
      ),
    ).toThrow(/axes=single/);
  });

  it("rejects a category name containing a comma (NOOP-159r2 FAIL 2 — would corrupt the comma-joined <comot:categories> on read-back)", () => {
    expect(() =>
      validateChartModel(
        baseModel({
          categories: ["Taipei, TW", "Kaohsiung", "Q3"],
          series: [{ name: "S", values: [1, 2, 3], axis: "left", color: null }],
        }),
      ),
    ).toThrow(/類別名稱不可包含逗號.*Taipei, TW/);
  });

  it("rejects a series name containing a comma", () => {
    expect(() =>
      validateChartModel(baseModel({ series: [{ name: "A, B", values: [1, 2, 3], axis: "left", color: null }] })),
    ).toThrow(/系列名稱不可包含逗號：A, B/);
  });

  it("rejects a series with axis=right when axes=single", () => {
    expect(() =>
      validateChartModel(baseModel({ series: [{ name: "S", values: [1, 2, 3], axis: "right", color: null }] })),
    ).toThrow(/axes 是 single/);
  });
});
