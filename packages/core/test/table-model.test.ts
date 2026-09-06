import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFont, type FontMetrics } from "../src/text-metrics.js";
import { checkSlideCompliance, parseSlide } from "../src/slide/format.js";
import { createTableElement } from "../src/table/edit.js";
import { readTableModel, validateTableModel, type TableModel } from "../src/table/model.js";

const FAMILY = "Noto Sans TC";
const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);

const SLIDE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>`;

function baseModel(overrides: Partial<TableModel> = {}): TableModel {
  return {
    cols: [100, 100],
    rows: [40, 40],
    header: false,
    theme: "dark",
    source: null,
    cells: [
      { row: 0, col: 0, text: "a", align: "left", fill: "none", fillOpacity: null, textFill: "#000000", fontWeight: 400, rowSpan: 1, colSpan: 1, repeat: false, generated: false },
      { row: 0, col: 1, text: "b", align: "left", fill: "none", fillOpacity: null, textFill: "#000000", fontWeight: 400, rowSpan: 1, colSpan: 1, repeat: false, generated: false },
      { row: 1, col: 0, text: "c", align: "left", fill: "none", fillOpacity: null, textFill: "#000000", fontWeight: 400, rowSpan: 1, colSpan: 1, repeat: false, generated: false },
      { row: 1, col: 1, text: "d", align: "left", fill: "none", fillOpacity: null, textFill: "#000000", fontWeight: 400, rowSpan: 1, colSpan: 1, repeat: false, generated: false },
    ],
    ...overrides,
  };
}

describe("readTableModel / render round-trip", () => {
  let fonts: Map<string, FontMetrics>;

  beforeAll(async () => {
    const font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fonts = new Map([[FAMILY, font]]);
  });

  it("reads back a freshly created table with the right shape", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-tbl1", { rows: 3, cols: 3, x: 100, y: 100 }, fonts);
    const model = readTableModel(svg, "el-tbl1");
    expect(model.cols.length).toBe(3);
    expect(model.rows.length).toBe(3);
    expect(model.cells.length).toBe(9);
    expect(model.header).toBe(true);
    expect(model.theme).toBe("dark");
    expect(model.source).toBeNull();
  });

  it("A3: parseSlide reports kind 'table' with the right cols length", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-tbl1", { rows: 3, cols: 3, x: 100, y: 100 }, fonts);
    const parsed = parseSlide(svg, "slides/001.svg");
    expect(parsed.elements[0].kind).toBe("table");
    expect(parsed.elements[0].table?.cols.length).toBe(3);
  });

  it("A2: checkSlideCompliance reports no issues for a freshly created table", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-tbl1", { rows: 3, cols: 3, x: 100, y: 100 }, fonts);
    expect(checkSlideCompliance(svg)).toEqual([]);
  });

  it("throws 找不到元素 for a missing element id", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-tbl1", { rows: 2, cols: 2, x: 0, y: 0 }, fonts);
    expect(() => readTableModel(svg, "el-nope")).toThrow("找不到元素：el-nope");
  });

  it("throws 不是表格 for an element that exists but is not a table", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="el-a"><rect width="1" height="1"/></g></svg>`;
    expect(() => readTableModel(svg, "el-a")).toThrow("元素 el-a 不是表格");
  });
});

describe("validateTableModel — grid coverage and span (plan §4.1/§4.7)", () => {
  it("accepts a fully covered 2x2 grid", () => {
    expect(() => validateTableModel(baseModel())).not.toThrow();
  });

  it("rejects a gap (a cell position with no covering cell)", () => {
    const model = baseModel({ cells: baseModel().cells.slice(0, 3) });
    expect(() => validateTableModel(model)).toThrow(/沒有任何內容/);
  });

  it("rejects an overlap (two cells claiming the same position)", () => {
    const cells = baseModel().cells;
    cells.push({ ...cells[0], colSpan: 2 });
    expect(() => validateTableModel({ ...baseModel(), cells })).toThrow(/重疊/);
  });

  it("accepts a merged cell whose span covers exactly its rectangle", () => {
    const model = baseModel({
      cells: [
        { row: 0, col: 0, text: "merged", align: "left", fill: "none", fillOpacity: null, textFill: "#000000", fontWeight: 400, rowSpan: 2, colSpan: 2, repeat: false, generated: false },
      ],
    });
    expect(() => validateTableModel(model)).not.toThrow();
  });

  it("rejects zero columns or zero rows", () => {
    expect(() => validateTableModel({ ...baseModel(), cols: [] })).toThrow(/至少要有一欄/);
    expect(() => validateTableModel({ ...baseModel(), rows: [] })).toThrow(/至少要有一列/);
  });

  it("rejects a non-positive column width", () => {
    expect(() => validateTableModel({ ...baseModel(), cols: [100, 0] })).toThrow(/欄寬/);
  });

  it("rejects an illegal theme", () => {
    expect(() => validateTableModel({ ...baseModel(), theme: "neon" as any })).toThrow(/theme/);
  });

  it("rejects fill that is rgba() or an 8-digit hex (ADR-0001 no-rgba rule)", () => {
    const cells = baseModel().cells;
    cells[0] = { ...cells[0], fill: "rgba(0,0,0,.5)" };
    expect(() => validateTableModel({ ...baseModel(), cells })).toThrow(/fill/);
  });

  it("rejects an illegal font-weight", () => {
    const cells = baseModel().cells;
    cells[0] = { ...cells[0], fontWeight: 450 };
    expect(() => validateTableModel({ ...baseModel(), cells })).toThrow(/font-weight/);
  });

  it("rejects more than one template row", () => {
    const cells = baseModel().cells.map((c, i) => (i < 2 ? { ...c, repeat: true } : c));
    // two different rows both flagged repeat: row 0 (i=0,1) is fine (same row);
    // force a second row to also be a template row to trigger the rejection.
    cells[2] = { ...cells[2], repeat: true };
    expect(() => validateTableModel({ ...baseModel(), cells })).toThrow(/模板列只能有一列/);
  });
});
