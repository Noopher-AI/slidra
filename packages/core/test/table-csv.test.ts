import { describe, expect, it } from "vitest";
import { parseTableCsv } from "../src/table/csv.js";

describe("parseTableCsv (plan §4.4/§6.2)", () => {
  it("parses a simple header + data rows", () => {
    const parsed = parseTableCsv("name,age\nAlice,30\nBob,25\n");
    expect(parsed.headers).toEqual(["name", "age"]);
    expect(parsed.rows).toEqual([
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
  });

  it("honours a quoted field containing a comma", () => {
    const parsed = parseTableCsv('city,note\n"Taipei, TW","hello"\n');
    expect(parsed.rows).toEqual([["Taipei, TW", "hello"]]);
  });

  it("honours a quoted field containing an embedded newline", () => {
    const parsed = parseTableCsv('note\n"line one\nline two"\n');
    expect(parsed.rows).toEqual([["line one\nline two"]]);
  });

  it("decodes a doubled quote inside a quoted field as one literal quote", () => {
    const parsed = parseTableCsv('note\n"she said ""hi"""\n');
    expect(parsed.rows).toEqual([['she said "hi"']]);
  });

  it("accepts CRLF line endings", () => {
    const parsed = parseTableCsv("a,b\r\n1,2\r\n");
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([["1", "2"]]);
  });

  it("strips a leading BOM", () => {
    const parsed = parseTableCsv("﻿a,b\n1,2\n");
    expect(parsed.headers).toEqual(["a", "b"]);
  });

  it("legal: header row only, zero data rows", () => {
    const parsed = parseTableCsv("a,b\n");
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([]);
  });

  it("throws on an empty header cell", () => {
    expect(() => parseTableCsv("a,\n1,2\n")).toThrow(/欄名不可為空白/);
  });

  it("throws on a duplicate header name", () => {
    expect(() => parseTableCsv("a,a\n1,2\n")).toThrow(/欄名重複：a/);
  });

  it("throws when a data row's column count does not match the header", () => {
    expect(() => parseTableCsv("a,b\n1,2,3\n")).toThrow(/第 2 列的欄數（3）與標頭（2）不符/);
  });

  it("throws on an unclosed quote", () => {
    expect(() => parseTableCsv('a\n"unterminated\n')).toThrow(/引號未封閉/);
  });

  it("throws on completely empty content", () => {
    expect(() => parseTableCsv("")).toThrow(/沒有任何內容/);
  });
});
