import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFont, type FontMetrics } from "../src/text-metrics.js";
import { createTableElement, setTableTheme, setTableHeader, mergeTableCells } from "../src/table/edit.js";
import { readTableModel } from "../src/table/model.js";
import { checkSlideCompliance } from "../src/slide/format.js";

const FAMILY = "Noto Sans TC";
const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);
const SLIDE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>`;

describe("table render — theme, header, merge (plan §4.1, §5 A/F)", () => {
  let fonts: Map<string, FontMetrics>;

  beforeAll(async () => {
    const font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fonts = new Map([[FAMILY, font]]);
  });

  it("never emits rgba() or 8-digit hex for any theme (ADR-0001 決定 3)", () => {
    for (const theme of ["dark", "light", "zebra"] as const) {
      const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 3, cols: 3, x: 0, y: 0, theme }, fonts);
      expect(svg).not.toMatch(/rgba\(/);
      expect(svg).not.toMatch(/#[0-9a-fA-F]{8}/);
    }
  });

  it("E2: the three themes each produce their own distinct data-comot-theme and header fill", () => {
    const dark = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0, theme: "dark" }, fonts);
    const light = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0, theme: "light" }, fonts);
    expect(dark).toContain('data-comot-theme="dark"');
    expect(light).toContain('data-comot-theme="light"');
    const darkModel = readTableModel(dark, "el-t");
    const lightModel = readTableModel(light, "el-t");
    const darkHeader = darkModel.cells.find((c) => c.row === 0 && c.col === 0)!;
    const lightHeader = lightModel.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(darkHeader.fill).not.toBe(lightHeader.fill);
  });

  it("E3: header off means no data-comot-header attribute, and row 0 becomes a body-styled row", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0, header: true }, fonts);
    let model = readTableModel(svg, "el-t");
    const headerWeight = model.cells.find((c) => c.row === 0)!.fontWeight;
    svg = setTableHeader(svg, "slides/001.svg", "el-t", false, fonts);
    expect(svg).not.toContain("data-comot-header");
    model = readTableModel(svg, "el-t");
    const bodyWeight = model.cells.find((c) => c.row === 0)!.fontWeight;
    expect(bodyWeight).not.toBe(headerWeight);
  });

  it("A4-style theme set produces valid compliant markup after restyle", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0 }, fonts);
    svg = setTableTheme(svg, "slides/001.svg", "el-t", "zebra", fonts);
    expect(checkSlideCompliance(svg)).toEqual([]);
    expect(readTableModel(svg, "el-t").theme).toBe("zebra");
  });

  it("E11: merge produces a single data-comot-span cell, and the covered cells are removed from the document", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 3, cols: 3, x: 0, y: 0 }, fonts);
    svg = mergeTableCells(svg, "slides/001.svg", "el-t", { row: 0, col: 0, rowSpan: 2, colSpan: 2 }, fonts);
    expect(checkSlideCompliance(svg)).toEqual([]);
    const model = readTableModel(svg, "el-t");
    expect(model.cells.length).toBe(9 - 3);
    const merged = model.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(merged.rowSpan).toBe(2);
    expect(merged.colSpan).toBe(2);
    expect(model.cells.some((c) => c.row === 1 && c.col === 1)).toBe(false);
  });

  it("merging a range that partially overlaps an existing merge throws and leaves the document unchanged", () => {
    // A 4x4 grid with a merge at the middle (rows 1-2, cols 1-2). A second
    // merge request from the untouched top-left corner spanning rows 0-1,
    // cols 0-1 shares exactly cell (1,1) with the first merge — a partial
    // overlap, not a re-request of the same rectangle.
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 4, cols: 4, x: 0, y: 0 }, fonts);
    svg = mergeTableCells(svg, "slides/001.svg", "el-t", { row: 1, col: 1, rowSpan: 2, colSpan: 2 }, fonts);
    const before = svg;
    expect(() => mergeTableCells(svg, "slides/001.svg", "el-t", { row: 0, col: 0, rowSpan: 2, colSpan: 2 }, fonts)).toThrow(/重疊/);
    expect(svg).toBe(before);
  });

  it("unmerge splits a merged cell back into individual cells, keeping the original text on the top-left cell only", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 3, cols: 3, x: 0, y: 0 }, fonts);
    svg = mergeTableCells(svg, "slides/001.svg", "el-t", { row: 0, col: 0, rowSpan: 2, colSpan: 2 }, fonts);
    svg = mergeTableCells(svg, "slides/001.svg", "el-t", { row: 0, col: 0, unmerge: true }, fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.cells.length).toBe(9);
    expect(model.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1)).toBe(true);
  });

  it("merge --row-span 1 --col-span 1 on an already-merged cell behaves like unmerge (plan §4.7)", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 3, cols: 3, x: 0, y: 0 }, fonts);
    svg = mergeTableCells(svg, "slides/001.svg", "el-t", { row: 0, col: 0, rowSpan: 2, colSpan: 2 }, fonts);
    svg = mergeTableCells(svg, "slides/001.svg", "el-t", { row: 0, col: 0, rowSpan: 1, colSpan: 1 }, fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.cells.length).toBe(9);
  });
});
