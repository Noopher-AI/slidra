import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { parseChartCsv } from "../src/chart/csv.js";

describe("parseChartCsv", () => {
  it("reads a normal CSV into categories and series", () => {
    const result = parseChartCsv("Quarter,Revenue,Cost\nQ1,120,80\nQ2,150,90\n");
    expect(result.categories).toEqual(["Q1", "Q2"]);
    expect(result.series).toEqual([
      { name: "Revenue", values: [120, 150] },
      { name: "Cost", values: [80, 90] },
    ]);
  });

  it("handles a quoted field containing a comma", () => {
    const result = parseChartCsv('Quarter,"Revenue, net"\nQ1,120\n');
    expect(result.series).toEqual([{ name: "Revenue, net", values: [120] }]);
  });

  it("handles an escaped double quote inside a quoted field", () => {
    const result = parseChartCsv('Quarter,"Say ""hi"""\nQ1,1\n');
    expect(result.series[0].name).toBe('Say "hi"');
  });

  it("strips a leading BOM", () => {
    const result = parseChartCsv("﻿Quarter,Revenue\nQ1,120\n");
    expect(result.categories).toEqual(["Q1"]);
  });

  it("accepts CRLF line endings", () => {
    const result = parseChartCsv("Quarter,Revenue\r\nQ1,120\r\nQ2,150\r\n");
    expect(result.categories).toEqual(["Q1", "Q2"]);
  });

  it("ignores a trailing blank line", () => {
    const result = parseChartCsv("Quarter,Revenue\nQ1,120\n\n");
    expect(result.categories).toEqual(["Q1"]);
  });

  it("throws when a row's column count does not match the header", () => {
    expect(() => parseChartCsv("Quarter,Revenue,Cost\nQ1,120\n")).toThrow(CoMotionError);
    expect(() => parseChartCsv("Quarter,Revenue,Cost\nQ1,120\n")).toThrow(/第 2 列/);
  });

  it("throws on a non-numeric value, naming the row and column", () => {
    expect(() => parseChartCsv("Quarter,Revenue\nQ1,abc\n")).toThrow(/第 2 列第 2 欄/);
  });

  it("throws on an empty file", () => {
    expect(() => parseChartCsv("")).toThrow(CoMotionError);
  });

  it("throws when there is a header but no data rows", () => {
    expect(() => parseChartCsv("Quarter,Revenue\n")).toThrow("CSV 沒有任何資料列");
  });

  it("accepts a single category row", () => {
    const result = parseChartCsv("Quarter,Revenue\nQ1,120\n");
    expect(result.categories).toEqual(["Q1"]);
  });
});
