import { describe, expect, it } from "vitest";
import { parseMarkdownTable } from "../src/table/markdown.js";

describe("parseMarkdownTable (plan §4.2/§4.7)", () => {
  it("parses a header, a left-default alignment row, and data rows", () => {
    const parsed = parseMarkdownTable(["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"));
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.aligns).toEqual(["left", "left"]);
    expect(parsed.rows).toEqual([["1", "2"]]);
  });

  it("parses all three alignment forms", () => {
    const parsed = parseMarkdownTable(["| a | b | c |", "|:---|---:|:---:|", "| 1 | 2 | 3 |"].join("\n"));
    expect(parsed.aligns).toEqual(["left", "right", "center"]);
  });

  it("treats an escaped pipe as a literal character, not a column separator", () => {
    const parsed = parseMarkdownTable(["| a |", "|---|", "| x \\| y |"].join("\n"));
    expect(parsed.rows).toEqual([["x | y"]]);
  });

  it("tolerates a table with no leading/trailing pipes", () => {
    const parsed = parseMarkdownTable(["a | b", "---|---", "1 | 2"].join("\n"));
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([["1", "2"]]);
  });

  it("throws when a data row's column count does not match the header", () => {
    expect(() => parseMarkdownTable(["| a | b |", "|---|---|", "| 1 |"].join("\n"))).toThrow(/欄數（1）與標頭（2）不符/);
  });

  it("throws when the second line is not a legal alignment row", () => {
    expect(() => parseMarkdownTable(["| a | b |", "| 1 | 2 |"].join("\n"))).toThrow(/對齊列/);
  });
});
