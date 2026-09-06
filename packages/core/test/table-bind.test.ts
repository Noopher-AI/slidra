import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFont, type FontMetrics } from "../src/text-metrics.js";
import {
  bindTableSource,
  createTableElement,
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  refreshTableSource,
  setTableCellStyle,
  setTableCellText,
  setTableColWidth,
  setTableFromCsv,
  setTableFromMarkdown,
} from "../src/table/edit.js";
import { readTableModel } from "../src/table/model.js";
import { parseTableCsv } from "../src/table/csv.js";
import { parseMarkdownTable } from "../src/table/markdown.js";
import { checkSlideCompliance, parseSlide } from "../src/slide/format.js";
import { scanDocument } from "../src/slide/scan.js";

const FAMILY = "Noto Sans TC";
const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);
const SLIDE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>`;

describe("table edit — cell/col/row operations (plan §4.2/§4.7)", () => {
  let fonts: Map<string, FontMetrics>;

  beforeAll(async () => {
    const font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fonts = new Map([[FAMILY, font]]);
  });

  it("A1: table create writes cols/rows/cell counts matching --rows/--cols", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 3, cols: 3, x: 100, y: 100 }, fonts);
    expect(svg).toContain('data-comot-type="table"');
    const cols = /data-comot-cols="([^"]+)"/.exec(svg)![1].split(" ");
    expect(cols.length).toBe(3);
    expect((svg.match(/data-comot-cell="/g) ?? []).length).toBe(9);
  });

  it("sets a cell's text and reads it back exactly", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0 }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 0, 0, "指標", fonts);
    expect(readTableModel(svg, "el-t").cells.find((c) => c.row === 0 && c.col === 0)!.text).toBe("指標");
  });

  it("throws for a cell address that does not exist", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0 }, fonts);
    expect(() => setTableCellText(svg, "slides/001.svg", "el-t", 5, 5, "x", fonts)).toThrow(/找不到儲存格/);
  });

  it("cell style set applies to a rectangular range", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 3, cols: 3, x: 0, y: 0 }, fonts);
    svg = setTableCellStyle(svg, "slides/001.svg", "el-t", { row: 0, col: 0, rowEnd: 1, colEnd: 1, attr: "align", value: "center" }, fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.cells.find((c) => c.row === 0 && c.col === 0)!.align).toBe("center");
    expect(model.cells.find((c) => c.row === 1 && c.col === 1)!.align).toBe("center");
    expect(model.cells.find((c) => c.row === 2 && c.col === 2)!.align).toBe("left");
  });

  it("cell style set rejects an illegal font-weight", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0 }, fonts);
    expect(() =>
      setTableCellStyle(svg, "slides/001.svg", "el-t", { row: 0, col: 0, attr: "font-weight", value: "450" }, fonts),
    ).toThrow(/font-weight/);
  });

  it("col width changes only the targeted column", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0, colWidth: 100 }, fonts);
    svg = setTableColWidth(svg, "slides/001.svg", "el-t", 1, 250, fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.cols).toEqual([100, 250]);
  });

  it("col insert shifts existing columns right and adds a blank column", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0 }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 0, 1, "right", fonts);
    svg = insertTableColumn(svg, "slides/001.svg", "el-t", 1, fonts);
    expect(checkSlideCompliance(svg)).toEqual([]);
    const model = readTableModel(svg, "el-t");
    expect(model.cols.length).toBe(3);
    expect(model.cells.find((c) => c.row === 0 && c.col === 2)!.text).toBe("right");
    expect(model.cells.find((c) => c.row === 0 && c.col === 1)!.text).toBe("");
  });

  it("col delete removes the column and shifts the rest left", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 3, x: 0, y: 0 }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 0, 2, "last", fonts);
    svg = deleteTableColumn(svg, "slides/001.svg", "el-t", 0, fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.cols.length).toBe(2);
    expect(model.cells.find((c) => c.row === 0 && c.col === 1)!.text).toBe("last");
  });

  it("col delete rejects deleting the last remaining column", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0 }, fonts);
    expect(() => deleteTableColumn(svg, "slides/001.svg", "el-t", 0, fonts)).toThrow(/至少要有一欄/);
  });

  it("row insert/delete round-trip and restyle row 0 as header when header stays on", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0, header: true }, fonts);
    svg = insertTableRow(svg, "slides/001.svg", "el-t", 0, fonts);
    let model = readTableModel(svg, "el-t");
    expect(model.rows.length).toBe(3);
    const newHeaderWeight = model.cells.find((c) => c.row === 0)!.fontWeight;
    svg = deleteTableRow(svg, "slides/001.svg", "el-t", 0, fonts);
    model = readTableModel(svg, "el-t");
    expect(model.rows.length).toBe(2);
    // Whatever is row 0 after the delete must carry the header weight again.
    expect(model.cells.find((c) => c.row === 0)!.fontWeight).toBe(newHeaderWeight);
  });

  it("row delete rejects deleting the last remaining row", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 1, cols: 2, x: 0, y: 0 }, fonts);
    expect(() => deleteTableRow(svg, "slides/001.svg", "el-t", 0, fonts)).toThrow(/至少要有一列/);
  });
});

describe("table data binding — CSV expansion and escaping (plan §4.4, §5 B/C)", () => {
  let fonts: Map<string, FontMetrics>;

  beforeAll(async () => {
    const font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fonts = new Map([[FAMILY, font]]);
  });

  function csvOf(text: string) {
    return parseTableCsv(text);
  }

  it("C2: binds and expands, generated cell count matches CSV row count", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 0, 0, "name", fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ name }}", fonts);
    svg = bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, csvOf("name\nAlice\nBob\nCarl\n"), fonts);
    expect(checkSlideCompliance(svg)).toEqual([]);
    const model = readTableModel(svg, "el-t");
    const generatedRows = new Set(model.cells.filter((c) => c.generated).map((c) => c.row));
    expect(generatedRows.size).toBe(3);
    expect(svg).toContain("Alice");
    expect(svg).toContain("Bob");
    expect(svg).toContain("Carl");
  });

  it("B2/D-adjacent: the template row is display:none and generated rows are not", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ name }}", fonts);
    svg = bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, csvOf("name\nAlice\n"), fonts);
    const roots = scanDocument(svg);
    const svgRoot = roots.find((n) => n.tag === "svg")!;
    function find(node: typeof svgRoot, id: string): typeof svgRoot | undefined {
      for (const child of node.children) {
        if (child.attributes.some((a) => a.name === "id" && a.value === id)) return child;
        const found = find(child, id);
        if (found) return found;
      }
      return undefined;
    }
    const table = find(svgRoot, "el-t")!;
    const templateCell = table.children.find((c) => c.attributes.some((a) => a.name === "data-comot-repeat"))!;
    const generatedCell = table.children.find((c) => c.attributes.some((a) => a.name === "data-comot-generated"))!;
    expect(templateCell.attributes.some((a) => a.name === "display" && a.value === "none")).toBe(true);
    expect(generatedCell.attributes.some((a) => a.name === "display")).toBe(false);
  });

  it("B3: generated cells are real <rect>/<text> primitives in the file (string-level, not browser-dependent)", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ name }}", fonts);
    svg = bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, csvOf("name\nAlice\n"), fonts);
    const generatedSection = svg.slice(svg.indexOf('data-comot-generated="1"') - 200, svg.indexOf('data-comot-generated="1"') + 400);
    expect(generatedSection).toMatch(/<rect/);
    expect(generatedSection).toMatch(/<text/);
  });

  it("C3: refresh re-expands from 3 rows to 5, then to 0, keeping the template row and comot:source", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ name }}", fonts);
    svg = bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, csvOf("name\nA\nB\nC\n"), fonts);
    let model = readTableModel(svg, "el-t");
    expect(new Set(model.cells.filter((c) => c.generated).map((c) => c.row)).size).toBe(3);

    svg = refreshTableSource(svg, "slides/001.svg", "el-t", csvOf("name\nA\nB\nC\nD\nE\n"), fonts);
    model = readTableModel(svg, "el-t");
    expect(new Set(model.cells.filter((c) => c.generated).map((c) => c.row)).size).toBe(5);

    svg = refreshTableSource(svg, "slides/001.svg", "el-t", csvOf("name\n"), fonts);
    model = readTableModel(svg, "el-t");
    expect(model.cells.filter((c) => c.generated).length).toBe(0);
    expect(model.source).toBe("assets/data/x.csv");
    expect(model.cells.some((c) => c.repeat)).toBe(true);
  });

  it("C4: HTML/script content in a CSV value is written escaped, and scanDocument finds zero <script> tags", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ name }}", fonts);
    svg = bindTableSource(
      svg,
      "slides/001.svg",
      "el-t",
      "assets/data/x.csv",
      undefined,
      csvOf('name\n"<script>alert(1)</script>"\n'),
      fonts,
    );
    // The column is narrow enough that the escaped string wraps across two
    // tspans — check the decoded model (which rejoins soft-wrapped tspans)
    // rather than a raw contiguous substring.
    const model = readTableModel(svg, "el-t");
    expect(model.cells.find((c) => c.generated)!.text).toBe("<script>alert(1)</script>");
    expect(svg).not.toMatch(/<script>/);
    const roots = scanDocument(svg);
    let scriptCount = 0;
    const walk = (nodes: readonly (typeof roots)[number][]) => {
      for (const node of nodes) {
        if (node.tag === "script") scriptCount++;
        walk(node.children);
      }
    };
    walk(roots);
    expect(scriptCount).toBe(0);
  });

  it("C5: ampersand/quote/angle-bracket content round-trips character-for-character through parseSlide", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ name }}", fonts);
    const value = `a & b < c > d "e"`;
    svg = bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, csvOf(`name\n"${value.replace(/"/g, '""')}"\n`), fonts);
    const model = readTableModel(svg, "el-t");
    const generated = model.cells.find((c) => c.generated)!;
    expect(generated.text).toBe(value);
  });

  it("C6: an unknown {{ column }} name throws and leaves the document unchanged", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ nope }}", fonts);
    const before = svg;
    expect(() => bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, csvOf("name\nA\n"), fonts)).toThrow(
      /找不到欄名/,
    );
    expect(svg).toBe(before);
  });

  it("a value containing {{ another }} is inserted literally, not re-expanded (single-pass substitution)", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 2, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ a }}", fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 1, "{{ b }}", fonts);
    svg = bindTableSource(
      svg,
      "slides/001.svg",
      "el-t",
      "assets/data/x.csv",
      undefined,
      csvOf('a,b\n"{{ b }}",literal\n'),
      fonts,
    );
    const model = readTableModel(svg, "el-t");
    const generatedRow = [...new Set(model.cells.filter((c) => c.generated).map((c) => c.row))][0];
    expect(model.cells.find((c) => c.row === generatedRow && c.col === 0)!.text).toBe("{{ b }}");
  });

  it("bind without --template-row on a header-only table throws (no row to template)", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 1, cols: 1, x: 0, y: 0, header: true }, fonts);
    expect(() =>
      bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, csvOf("a\n1\n"), fonts),
    ).toThrow(/沒有可當模板的列/);
  });

  it("bind with --template-row explicitly pointing at the header row throws", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    expect(() => bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", 0, csvOf("a\n1\n"), fonts)).toThrow(
      /表頭列不能當模板列/,
    );
  });

  it("refresh on an unbound table throws", () => {
    const svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0 }, fonts);
    expect(() => refreshTableSource(svg, "slides/001.svg", "el-t", csvOf("a\n1\n"), fonts)).toThrow(/沒有資料來源/);
  });
});

describe("table set --from / --markdown (plan §4.2, §5 D)", () => {
  let fonts: Map<string, FontMetrics>;

  beforeAll(async () => {
    const font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fonts = new Map([[FAMILY, font]]);
  });

  it("D1: --from replaces the table with a literal grid, no comot:source/repeat/generated markers left", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 1, cols: 1, x: 0, y: 0 }, fonts);
    const csv = parseTableCsv("name,age\nAlice,30\nBob,25\n");
    svg = setTableFromCsv(svg, "slides/001.svg", "el-t", csv, fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.rows.length).toBe(3); // header + 2 data rows
    expect(model.source).toBeNull();
    expect(svg).not.toContain("comot:source");
    expect(svg).not.toContain("data-comot-repeat");
    expect(svg).not.toContain("data-comot-generated");
  });

  it("D2: --markdown applies per-column alignment from the alignment row", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 1, cols: 1, x: 0, y: 0 }, fonts);
    const markdown = parseMarkdownTable(["| a | b |", "|:---|---:|", "| 1 | 2 |"].join("\n"));
    svg = setTableFromMarkdown(svg, "slides/001.svg", "el-t", markdown, fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.cells.filter((c) => c.col === 0).every((c) => c.align === "left")).toBe(true);
    expect(model.cells.filter((c) => c.col === 1).every((c) => c.align === "right")).toBe(true);
  });

  it("--markdown with mismatched row column counts throws", () => {
    expect(() => parseMarkdownTable(["| a | b |", "|---|---|", "| 1 |"].join("\n"))).toThrow(/欄數/);
  });

  it("overwriting a previously bound table via --from removes its binding entirely", () => {
    let svg = createTableElement(SLIDE, "slides/001.svg", "el-t", { rows: 2, cols: 1, x: 0, y: 0, header: true }, fonts);
    svg = setTableCellText(svg, "slides/001.svg", "el-t", 1, 0, "{{ name }}", fonts);
    svg = bindTableSource(svg, "slides/001.svg", "el-t", "assets/data/x.csv", undefined, parseTableCsv("name\nA\n"), fonts);
    svg = setTableFromCsv(svg, "slides/001.svg", "el-t", parseTableCsv("x\n1\n"), fonts);
    const model = readTableModel(svg, "el-t");
    expect(model.source).toBeNull();
    expect(model.cells.every((c) => !c.generated && !c.repeat)).toBe(true);
  });
});
