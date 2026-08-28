import { beforeAll, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { createFontBook, type FontBook } from "../src/font/metrics.js";
import { readBundledFontBytes } from "../src/font/bundle.js";
import { breakAllowedBetween, NO_BREAK_BEFORE, wrapText } from "../src/text/wrap.js";
import { renderTextBoxContent } from "../src/text/render.js";

const FAMILY = "Noto Sans TC";

describe("wrapText (#76)", () => {
  let book: FontBook;

  beforeAll(async () => {
    book = createFontBook([await readBundledFontBytes()]);
  });

  // The sample and target width are copied from the plan's own worked
  // example (§4 of comotion-70-b2-textbox.md's slide-format shape) — the
  // exact line strings below are not recomputed by wrapText, they are the
  // literal strings the design doc names.
  const SAMPLE = "文字框有寬度，文字寫滿就折到下一行。";

  it("wraps the worked example into exactly the 2 lines the design doc names, at width 440", () => {
    const wrapped = wrapText(SAMPLE, { width: 440, style: { fontFamily: FAMILY, fontSize: 40 }, book });
    expect(wrapped.lines.map((line) => line.text)).toEqual(["文字框有寬度，文字寫滿", "就折到下一行。"]);
  });

  it("wraps the same text into exactly 3 lines at a narrower width (280)", () => {
    const wrapped = wrapText(SAMPLE, { width: 280, style: { fontFamily: FAMILY, fontSize: 40 }, book });
    expect(wrapped.lines.map((line) => line.text)).toEqual([
      "文字框有寬度，",
      "文字寫滿就折到",
      "下一行。",
    ]);
  });

  it("never starts a line with a closing/trailing punctuation mark (no line ends right before one)", () => {
    for (const width of [200, 240, 280, 320, 360, 400, 440]) {
      const wrapped = wrapText(SAMPLE, { width, style: { fontFamily: FAMILY, fontSize: 40 }, book });
      for (const line of wrapped.lines.slice(1)) {
        const firstCodePoint = line.text.codePointAt(0);
        expect(firstCodePoint === undefined || !NO_BREAK_BEFORE.has(firstCodePoint)).toBe(true);
      }
    }
  });

  // The invariant the whole text-box data model rests on: nothing is ever
  // deleted, only broken. A break after a space leaves the space attached
  // to the end of the previous line, so plain concatenation is lossless.
  describe("concatenating the returned lines reproduces the input byte for byte", () => {
    const cases: ReadonlyArray<[string, number, number]> = [
      [SAMPLE, 40, 200],
      [SAMPLE, 40, 280],
      [SAMPLE, 40, 440],
      [SAMPLE, 40, 1],
      ["「引用」，。文字框有寬度，文字寫滿就折到下一行，這是第三行測試用的內容。", 40, 200],
      ["aaaa bbbb cccc dddd", 20, 60],
      ["Supercalifragilisticexpialidocious", 40, 100],
      ["", 40, 300],
      ["驗", 40, 5],
    ];

    it.each(cases)("%j at width %i, fontSize %i", (text, fontSize, width) => {
      const wrapped = wrapText(text, { width, style: { fontFamily: FAMILY, fontSize }, book });
      expect(wrapped.lines.map((line) => line.text).join("")).toBe(text);
    });
  });

  it("a single code point wider than the box gets its own line, and that line is the one shape allowed to overflow", () => {
    const wrapped = wrapText("驗", { width: 5, style: { fontFamily: FAMILY, fontSize: 40 }, book });
    expect(wrapped.lines).toHaveLength(1);
    expect(wrapped.lines[0].text).toBe("驗");
    expect(wrapped.lines[0].width).toBeGreaterThan(5);
  });

  it("a Latin word longer than the box breaks character by character, terminates, and never overflows", () => {
    const wrapped = wrapText("Supercalifragilisticexpialidocious", {
      width: 100,
      style: { fontFamily: FAMILY, fontSize: 40 },
      book,
    });
    expect(wrapped.lines.length).toBeGreaterThan(1);
    for (const line of wrapped.lines) {
      expect(line.text.length).toBeGreaterThan(0);
      expect(line.width).toBeLessThanOrEqual(100);
    }
  });

  it("empty text produces exactly one empty line, so the box still has a height", () => {
    const wrapped = wrapText("", { width: 300, style: { fontFamily: FAMILY, fontSize: 40 }, book });
    expect(wrapped.lines).toEqual([{ text: "", y: wrapped.ascent, width: 0 }]);
    expect(wrapped.height).toBe(wrapped.lineHeight);
  });

  it("rejects width <= 0, NaN and Infinity before any measurement", () => {
    for (const width of [0, -10, NaN, Infinity]) {
      expect(() => wrapText("x", { width, style: { fontFamily: FAMILY, fontSize: 40 }, book })).toThrow(
        CoMotionError,
      );
    }
  });

  it("delegates character validation to FontBook — a control character still throws, not reimplemented here", () => {
    expect(() =>
      wrapText("a\nb", { width: 300, style: { fontFamily: FAMILY, fontSize: 40 }, book }),
    ).toThrow(CoMotionError);
  });

  it("a glyph the packed font lacks still throws (軍令 2: no .notdef fallback)", () => {
    // U+E000 is in the Private Use Area — no font legitimately maps it, and
    // Noto Sans TC in particular does not.
    expect(() =>
      wrapText(String.fromCodePoint(0xe000), { width: 300, style: { fontFamily: FAMILY, fontSize: 40 }, book }),
    ).toThrow(CoMotionError);
  });

  it("baselines are ascent + i * lineHeight, both read off the face (hhea), relative to the box's top-left", () => {
    const style = { fontFamily: FAMILY, fontSize: 40 };
    const face = book.faceFor(style);
    const expectedAscent = (face.ascender / face.unitsPerEm) * 40;
    const expectedLineHeight = ((face.ascender - face.descender + face.lineGap) / face.unitsPerEm) * 40;

    const wrapped = wrapText(SAMPLE, { width: 280, style, book });
    expect(wrapped.ascent).toBeCloseTo(expectedAscent, 9);
    expect(wrapped.lineHeight).toBeCloseTo(expectedLineHeight, 9);
    wrapped.lines.forEach((line, i) => {
      expect(line.y).toBeCloseTo(expectedAscent + i * expectedLineHeight, 9);
    });
    expect(wrapped.height).toBeCloseTo(wrapped.lines.length * expectedLineHeight, 9);
  });
});

describe("breakAllowedBetween", () => {
  const cp = (ch: string) => ch.codePointAt(0) as number;

  it("permits a break right after a space", () => {
    expect(breakAllowedBetween(cp(" "), cp("a"))).toBe(true);
  });

  it("never permits a break inside a Latin word", () => {
    expect(breakAllowedBetween(cp("a"), cp("b"))).toBe(false);
  });

  it("permits a break between two CJK characters", () => {
    expect(breakAllowedBetween(cp("文"), cp("字"))).toBe(true);
  });

  it("permits a break between CJK and Latin in either direction", () => {
    expect(breakAllowedBetween(cp("字"), cp("A"))).toBe(true);
    expect(breakAllowedBetween(cp("A"), cp("字"))).toBe(true);
  });

  it("never permits a break right before a closing punctuation mark, even between two CJK characters", () => {
    expect(breakAllowedBetween(cp("字"), cp("」"))).toBe(false);
    expect(breakAllowedBetween(cp("字"), cp("，"))).toBe(false);
  });

  it("never permits a break right after an opening punctuation mark", () => {
    expect(breakAllowedBetween(cp("「"), cp("字"))).toBe(false);
  });
});

describe("renderTextBoxContent (#76)", () => {
  it("serializes one <tspan x=\"0\" y=\"…\"> per line, ascending y, no whitespace anywhere between tags", () => {
    const content = renderTextBoxContent([
      { text: "第一行", y: 47.376, width: 100 },
      { text: "第二行", y: 99.5, width: 100 },
    ]);
    expect(content).toBe('<tspan x="0" y="47.376">第一行</tspan><tspan x="0" y="99.5">第二行</tspan>');
  });

  it("escapes &, < and > in the line text", () => {
    const content = renderTextBoxContent([{ text: "A & B < C > D", y: 10, width: 1 }]);
    expect(content).toBe('<tspan x="0" y="10">A &amp; B &lt; C &gt; D</tspan>');
  });

  it("renders a single empty line as an empty tspan, not an omitted one", () => {
    expect(renderTextBoxContent([{ text: "", y: 10, width: 0 }])).toBe('<tspan x="0" y="10"></tspan>');
  });

  it("rounds y with the campaign-wide 4-decimal rule (formatSvgNumber)", () => {
    expect(renderTextBoxContent([{ text: "x", y: 10.00001, width: 1 }])).toBe('<tspan x="0" y="10">x</tspan>');
  });
});
