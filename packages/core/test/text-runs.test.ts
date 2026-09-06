import { describe, expect, it } from "vitest";
import { applyRunStyle, readTextBoxRuns, type TextRun } from "../src/text/runs.js";
import { scanDocument } from "../src/slide/scan.js";

/** Parses a standalone `<text>…</text>` snippet and returns its scanned node, for `readTextBoxRuns` to read. */
function textNode(markup: string) {
  const [node] = scanDocument(markup);
  return node;
}

describe("readTextBoxRuns (NOOP-65 決定 B — runs 的事實來源就是 tspan)", () => {
  it("a line with no nested tspan produces no runs", () => {
    const markup = '<text xml:space="preserve"><tspan x="0" y="10">Hi</tspan></text>';
    const { content, runs } = readTextBoxRuns(textNode(markup), markup);
    expect(content).toBe("Hi");
    expect(runs).toEqual([]);
  });

  it("a bold run in the middle of a line reads back as one TextRun over the right range", () => {
    const markup =
      '<text xml:space="preserve"><tspan x="0" y="10">粗<tspan font-weight="bold">體字</tspan>示範</tspan></text>';
    const { content, runs } = readTextBoxRuns(textNode(markup), markup);
    expect(content).toBe("粗體字示範");
    expect(runs).toEqual([{ start: 1, end: 3, fontWeight: "bold", fontStyle: undefined }]);
  });

  it("a hardBreak line appends \\n to the content and no run ever covers that index", () => {
    const markup =
      '<text xml:space="preserve"><tspan x="0" y="10" data-comot-break="1">AB</tspan><tspan x="0" y="30">CD</tspan></text>';
    const { content, runs } = readTextBoxRuns(textNode(markup), markup);
    expect(content).toBe("AB\nCD");
    expect(runs).toEqual([]);
  });

  it("a run spanning a hardBreak reads back as two separate runs, one per line, never covering the \\n index", () => {
    const markup =
      '<text xml:space="preserve"><tspan x="0" y="10" data-comot-break="1">A<tspan font-style="italic">B</tspan></tspan>' +
      '<tspan x="0" y="30"><tspan font-style="italic">C</tspan>D</tspan></text>';
    const { content, runs } = readTextBoxRuns(textNode(markup), markup);
    expect(content).toBe("AB\nCD");
    // B is index 1, \n is index 2 (unrepresented), C is index 3.
    expect(runs).toEqual([
      { start: 1, end: 2, fontWeight: undefined, fontStyle: "italic" },
      { start: 3, end: 4, fontWeight: undefined, fontStyle: "italic" },
    ]);
  });

  it("adjacent run tspans with identical attributes read back merged into one run", () => {
    const markup =
      '<text xml:space="preserve"><tspan x="0" y="10"><tspan font-weight="bold">A</tspan><tspan font-weight="bold">B</tspan>C</tspan></text>';
    const { runs } = readTextBoxRuns(textNode(markup), markup);
    expect(runs).toEqual([{ start: 0, end: 2, fontWeight: "bold", fontStyle: undefined }]);
  });

  it("decodes XML entities in both plain and run text", () => {
    const markup =
      '<text xml:space="preserve"><tspan x="0" y="10">A &amp; <tspan font-weight="bold">B &lt; C</tspan></tspan></text>';
    const { content } = readTextBoxRuns(textNode(markup), markup);
    expect(content).toBe("A & B < C");
  });
});

describe("applyRunStyle (NOOP-65 §4.2)", () => {
  it("sets a style over an unstyled range, creating exactly one new run", () => {
    const result = applyRunStyle([], 2, 5, { fontWeight: "bold" });
    expect(result).toEqual([{ start: 2, end: 5, fontWeight: "bold", fontStyle: undefined }]);
  });

  it("overlapping partial overlap: covered part takes the new value, uncovered part keeps the original", () => {
    const existing: TextRun[] = [{ start: 0, end: 10, fontWeight: "bold" }];
    const result = applyRunStyle(existing, 5, 10, { fontStyle: "italic" });
    expect(result).toEqual([
      { start: 0, end: 5, fontWeight: "bold", fontStyle: undefined },
      { start: 5, end: 10, fontWeight: "bold", fontStyle: "italic" },
    ]);
  });

  it("adjacent runs with identical resulting attributes merge into one", () => {
    const existing: TextRun[] = [
      { start: 0, end: 5, fontWeight: "bold" },
      { start: 5, end: 10, fontWeight: "bold" },
    ];
    const result = applyRunStyle(existing, 3, 7, {});
    expect(result).toEqual([{ start: 0, end: 10, fontWeight: "bold", fontStyle: undefined }]);
  });

  it("clearing the only set attribute over the whole range drops the run entirely (no empty tspan)", () => {
    const existing: TextRun[] = [{ start: 0, end: 5, fontWeight: "bold" }];
    const result = applyRunStyle(existing, 0, 5, { fontWeight: null });
    expect(result).toEqual([]);
  });

  it("clearing one attribute while the other survives keeps a run with just that attribute", () => {
    const existing: TextRun[] = [{ start: 0, end: 5, fontWeight: "bold", fontStyle: "italic" }];
    const result = applyRunStyle(existing, 0, 5, { fontWeight: null });
    expect(result).toEqual([{ start: 0, end: 5, fontWeight: undefined, fontStyle: "italic" }]);
  });

  it("omitting a field from the update leaves that axis untouched even inside the range", () => {
    const existing: TextRun[] = [{ start: 0, end: 5, fontWeight: "bold", fontStyle: "italic" }];
    // fontWeight key entirely absent from the update -> stays "bold"; only fontStyle is overwritten.
    const result = applyRunStyle(existing, 0, 5, { fontStyle: "oblique" });
    expect(result).toEqual([{ start: 0, end: 5, fontWeight: "bold", fontStyle: "oblique" }]);
  });

  it("a range with no existing runs and a style update creates runs only where boundaries require, never touching outside [start,end)", () => {
    const existing: TextRun[] = [{ start: 0, end: 3, fontWeight: "bold" }];
    const result = applyRunStyle(existing, 3, 6, { fontStyle: "italic" });
    expect(result).toEqual([
      { start: 0, end: 3, fontWeight: "bold", fontStyle: undefined },
      { start: 3, end: 6, fontWeight: undefined, fontStyle: "italic" },
    ]);
  });

  it("does not mutate the input array", () => {
    const existing: TextRun[] = [{ start: 0, end: 5, fontWeight: "bold" }];
    const before = JSON.stringify(existing);
    applyRunStyle(existing, 1, 3, { fontStyle: "italic" });
    expect(JSON.stringify(existing)).toBe(before);
  });

  it("a zero-width range ([a, a)) is a no-op: nothing changes", () => {
    const existing: TextRun[] = [{ start: 0, end: 5, fontWeight: "bold" }];
    const result = applyRunStyle(existing, 2, 2, { fontStyle: "italic" });
    expect(result).toEqual(existing);
  });
});
