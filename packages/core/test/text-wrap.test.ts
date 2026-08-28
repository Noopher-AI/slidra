import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { measureTextWidth, parseFont, type FontMetrics } from "../src/text-metrics.js";
import { breakAllowedBetween, NO_BREAK_BEFORE, wrapText } from "../src/text/wrap.js";
import { renderTextBoxContent } from "../src/text/render.js";

const FAMILY = "Noto Sans TC";
const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);

describe("wrapText (#76)", () => {
  let font: FontMetrics;

  beforeAll(async () => {
    font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
  });

  // The sample and target width are copied from the plan's own worked
  // example (§4 of comotion-70-b2-textbox.md's slide-format shape) — the
  // exact line strings below are not recomputed by wrapText, they are the
  // literal strings the design doc names.
  const SAMPLE = "文字框有寬度，文字寫滿就折到下一行。";

  it("wraps the worked example into exactly the 2 lines the design doc names, at width 440", () => {
    const wrapped = wrapText(SAMPLE, { width: 440, font, fontSizePx: 40 });
    expect(wrapped.lines.map((line) => line.text)).toEqual(["文字框有寬度，文字寫滿", "就折到下一行。"]);
  });

  it("wraps the same text into exactly 3 lines at a narrower width (280)", () => {
    const wrapped = wrapText(SAMPLE, { width: 280, font, fontSizePx: 40 });
    expect(wrapped.lines.map((line) => line.text)).toEqual([
      "文字框有寬度，",
      "文字寫滿就折到",
      "下一行。",
    ]);
  });

  it("never starts a line with a closing/trailing punctuation mark (no line ends right before one)", () => {
    for (const width of [200, 240, 280, 320, 360, 400, 440]) {
      const wrapped = wrapText(SAMPLE, { width, font, fontSizePx: 40 });
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

    it.each(cases)("%j at width %i, fontSize %i", (text, fontSizePx, width) => {
      const wrapped = wrapText(text, { width, font, fontSizePx });
      expect(wrapped.lines.map((line) => line.text).join("")).toBe(text);
    });
  });

  it("a single code point wider than the box gets its own line, and that line is the one shape allowed to overflow", () => {
    const wrapped = wrapText("驗", { width: 5, font, fontSizePx: 40 });
    expect(wrapped.lines).toHaveLength(1);
    expect(wrapped.lines[0].text).toBe("驗");
    expect(wrapped.lines[0].width).toBeGreaterThan(5);
  });

  it("a Latin word longer than the box breaks character by character, terminates, and never overflows", () => {
    const wrapped = wrapText("Supercalifragilisticexpialidocious", {
      width: 100,
      font,
      fontSizePx: 40,
    });
    expect(wrapped.lines.length).toBeGreaterThan(1);
    for (const line of wrapped.lines) {
      expect(line.text.length).toBeGreaterThan(0);
      expect(line.width).toBeLessThanOrEqual(100);
    }
  });

  it("empty text produces exactly one empty line, so the box still has a height", () => {
    const wrapped = wrapText("", { width: 300, font, fontSizePx: 40 });
    expect(wrapped.lines).toEqual([{ text: "", y: wrapped.ascent, width: 0 }]);
    expect(wrapped.height).toBe(wrapped.lineHeight);
  });

  it("rejects width <= 0, NaN and Infinity before any measurement", () => {
    for (const width of [0, -10, NaN, Infinity]) {
      expect(() => wrapText("x", { width, font, fontSizePx: 40 })).toThrow(CoMotionError);
    }
  });

  // #71's finding (NOOP-47): the subset presentation font necessarily lacks
  // some code points, and `measureTextWidth` does not throw for one — it
  // measures glyph 0 (.notdef)'s advance, which this font defines as one
  // full em. wrapText must not invent its own handling for this case: it
  // delegates every width, uncovered code point included, straight to
  // `measureTextWidth` (see that module's header comment, 軍令 2), so its
  // line breaks must agree exactly with what measureTextWidth reports for
  // the same substrings.
  it("a cmap-uncovered code point does not throw — wrapText's line breaks match measureTextWidth's own per-line widths", () => {
    // U+E000 is in the Private Use Area; the bundled subset font's cmap
    // does not map it, so every occurrence measures as glyph 0's advance.
    const uncovered = String.fromCodePoint(0xe000);
    const text = `文字${uncovered}${uncovered}框`;
    expect(() => wrapText(text, { width: 60, font, fontSizePx: 40 })).not.toThrow();

    const wrapped = wrapText(text, { width: 60, font, fontSizePx: 40 });
    expect(wrapped.lines.map((line) => line.text).join("")).toBe(text);
    for (const line of wrapped.lines) {
      expect(line.width).toBe(measureTextWidth(font, line.text, 40));
    }
  });

  it("baselines are ascent + i * lineHeight, both read off the face (hhea), relative to the box's top-left", () => {
    const fontSizePx = 40;
    const expectedAscent = (font.ascender / font.unitsPerEm) * fontSizePx;
    const expectedLineHeight = ((font.ascender - font.descender + font.lineGap) / font.unitsPerEm) * fontSizePx;

    const wrapped = wrapText(SAMPLE, { width: 280, font, fontSizePx });
    expect(wrapped.ascent).toBe(expectedAscent);
    expect(wrapped.lineHeight).toBe(expectedLineHeight);
    wrapped.lines.forEach((line, i) => {
      expect(line.y).toBe(expectedAscent + i * expectedLineHeight);
    });
    expect(wrapped.height).toBe(wrapped.lines.length * expectedLineHeight);
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
  it('serializes one <tspan x="0" y="…"> per line, ascending y, no whitespace anywhere between tags', () => {
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
