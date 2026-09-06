import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  replaceElementText,
  resizeTextBox,
  setTextRunStyle,
  substituteDynamicText,
} from "../src/element-text.js";
import { wrapText } from "../src/text/wrap.js";
import { renderTextBoxContent } from "../src/text/render.js";
import { formatSvgNumber } from "../src/svg-number.js";
import { measureTextWidth, parseFont, type FontMetrics } from "../src/text-metrics.js";

const FAMILY = "Noto Sans TC";
const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);

/** One CJK ideograph — repeated to build content whose per-line width is exact multiples of a single, independently measured char width, so a test can pick a box width that deterministically forces a chosen line count without depending on wrapText's own break-selection logic (only on `measureTextWidth`, the one shared measurement primitive). */
const CHAR = "字";

/** A text box container shaped exactly like `workspace.ts`'s `addTextBox` output: `data-comot-text-width`/`-height` (and `-align` when non-left) on the container, content already wrapped and rendered. */
function buildTextBoxSvg(
  elementId: string,
  text: string,
  width: number,
  fontSize: number,
  font: FontMetrics,
  options: { align?: "left" | "center" | "right" } = {},
): string {
  const align = options.align ?? "left";
  const wrapped = wrapText(text, { width, font, fontSizePx: fontSize, align });
  const content = renderTextBoxContent(wrapped.lines);
  const alignAttr = align === "left" ? "" : ` data-comot-text-align="${align}"`;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
    `<g id="${elementId}" data-comot-text-width="${formatSvgNumber(width)}" data-comot-text-height="${formatSvgNumber(wrapped.height)}"${alignAttr}>` +
    `<text font-family="${FAMILY}" font-size="${formatSvgNumber(fontSize)}" xml:space="preserve">${content}</text>` +
    "</g></svg>"
  );
}

/** Same shape, but with NO `data-comot-text-height` at all — a box written before NOOP-65 (§4.5 compatibility: a legacy file). */
function buildLegacyTextBoxSvg(elementId: string, text: string, width: number, fontSize: number, font: FontMetrics): string {
  const wrapped = wrapText(text, { width, font, fontSizePx: fontSize });
  const content = renderTextBoxContent(wrapped.lines);
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
    `<g id="${elementId}" data-comot-text-width="${formatSvgNumber(width)}">` +
    `<text font-family="${FAMILY}" font-size="${formatSvgNumber(fontSize)}" xml:space="preserve">${content}</text>` +
    "</g></svg>"
  );
}

function heightOf(svg: string): number {
  const match = /data-comot-text-height="([^"]+)"/.exec(svg);
  if (!match) throw new Error(`test helper: no data-comot-text-height in: ${svg}`);
  return Number(match[1]);
}

// This is the structural guarantee ticket #3 hinges on: replaceElementText
// must be a string splice, not a parse-and-reserialize, so every byte
// outside the target element's text content is left untouched.
describe("replaceElementText", () => {
  it("changes only the target element's text, byte-identical elsewhere", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
      '  <text id="el-aaa" data-comot-name="標題" x="640" y="360" text-anchor="middle" font-size="48">Hello</text>\n' +
      "</svg>\n";

    const result = replaceElementText(svg, "el-aaa", "World");

    expect(result).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n' +
        '  <text id="el-aaa" data-comot-name="標題" x="640" y="360" text-anchor="middle" font-size="48">World</text>\n' +
        "</svg>\n",
    );
  });

  it("leaves sibling elements completely untouched", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
      '  <text id="el-a" x="0" y="0">first</text>\n' +
      '  <text id="el-b" x="10" y="10">second</text>\n' +
      "</svg>\n";

    const result = replaceElementText(svg, "el-b", "changed");

    expect(result).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
        '  <text id="el-a" x="0" y="0">first</text>\n' +
        '  <text id="el-b" x="10" y="10">changed</text>\n' +
        "</svg>\n",
    );
  });

  it("allows clearing text to an empty string", () => {
    const svg = '<svg><text id="el-a">old</text></svg>';

    const result = replaceElementText(svg, "el-a", "");

    expect(result).toBe('<svg><text id="el-a"></text></svg>');
  });

  it("escapes <, >, & and stores a raw quote as-is in the new text", () => {
    const svg = '<svg><text id="el-a">old</text></svg>';

    const result = replaceElementText(svg, "el-a", `<tag> & "quoted"`);

    expect(result).toBe('<svg><text id="el-a">&lt;tag&gt; &amp; "quoted"</text></svg>');
  });

  it("allows and preserves a literal newline in the new text", () => {
    const svg = '<svg><text id="el-a">old</text></svg>';

    const result = replaceElementText(svg, "el-a", "line1\nline2");

    expect(result).toBe('<svg><text id="el-a">line1\nline2</text></svg>');
  });

  it("throws when the element id is not present in the document", () => {
    const svg = '<svg><text id="el-a">old</text></svg>';

    expect(() => replaceElementText(svg, "el-does-not-exist", "x")).toThrow();
  });

  it("throws when the matched element is self-closing and holds no text (e.g. an image)", () => {
    const svg = '<svg><image id="el-a" href="foo.png"/></svg>';

    expect(() => replaceElementText(svg, "el-a", "x")).toThrow();
  });

  it("matches the element whose real id is el-a, not an earlier data-id or xml:id carrying the same string", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
      '  <rect data-id="el-a" x="0" y="0" width="1" height="1"></rect>\n' +
      '  <g xml:id="el-a"><rect x="0" y="0" width="1" height="1"></rect></g>\n' +
      '  <text id="el-a">old</text>\n' +
      "</svg>\n";

    const result = replaceElementText(svg, "el-a", "new");

    expect(result).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
        '  <rect data-id="el-a" x="0" y="0" width="1" height="1"></rect>\n' +
        '  <g xml:id="el-a"><rect x="0" y="0" width="1" height="1"></rect></g>\n' +
        '  <text id="el-a">new</text>\n' +
        "</svg>\n",
    );
  });

  it("edits the live element and leaves an earlier comment carrying the same id untouched", () => {
    const svg =
      "<svg>\n" +
      '  <!-- <text id="el-a">old</text> -->\n' +
      '  <text id="el-a">live</text>\n' +
      "</svg>\n";

    const result = replaceElementText(svg, "el-a", "new");

    expect(result).toBe(
      "<svg>\n" +
        '  <!-- <text id="el-a">old</text> -->\n' +
        '  <text id="el-a">new</text>\n' +
        "</svg>\n",
    );
  });

  it("edits the live element and leaves an earlier CDATA section carrying the same id untouched", () => {
    const svg =
      "<svg>\n" +
      '  <![CDATA[ <text id="el-a">old</text> ]]>\n' +
      '  <text id="el-a">live</text>\n' +
      "</svg>\n";

    const result = replaceElementText(svg, "el-a", "new");

    expect(result).toBe(
      "<svg>\n" +
        '  <![CDATA[ <text id="el-a">old</text> ]]>\n' +
        '  <text id="el-a">new</text>\n' +
        "</svg>\n",
    );
  });

  it("throws when the id only appears inside a comment — the element does not exist", () => {
    const svg = '<svg>\n  <!-- <text id="el-a">old</text> -->\n</svg>\n';

    expect(() => replaceElementText(svg, "el-a", "new")).toThrow();
  });

  it("throws naming the element when the target tag is not text-bearing (rect)", () => {
    const svg = '<svg><rect id="el-a" x="0" y="0" width="1" height="1"></rect></svg>';

    expect(() => replaceElementText(svg, "el-a", "x")).toThrow("el-a");
  });

  it("throws naming the element when the target tag is not text-bearing (g), without splicing at a nested </g>", () => {
    const svg = '<svg><g id="el-a"><g></g></g></svg>';

    expect(() => replaceElementText(svg, "el-a", "x")).toThrow("el-a");
  });

  it("throws when newText contains an XML-forbidden control character (U+0001)", () => {
    const svg = '<svg><text id="el-a">old</text></svg>';

    expect(() => replaceElementText(svg, "el-a", "badchar")).toThrow();
  });

  it("allows tab, newline and carriage return, which XML 1.0 explicitly permits", () => {
    const svg = '<svg><text id="el-a">old</text></svg>';

    const result = replaceElementText(svg, "el-a", "a\tb\nc\rd");

    expect(result).toBe('<svg><text id="el-a">a\tb\nc\rd</text></svg>');
  });

  it("finds the real closing tag past a comment inside the element that literally contains </text>", () => {
    const svg = '<svg><text id="el-a">old<!-- </text> --></text></svg>';

    const result = replaceElementText(svg, "el-a", "new");

    expect(result).toBe('<svg><text id="el-a">new</text></svg>');
  });

  it("finds the real closing tag past a CDATA section inside the element that literally contains </text>", () => {
    const svg = '<svg><text id="el-a">old<![CDATA[ </text> ]]></text></svg>';

    const result = replaceElementText(svg, "el-a", "new");

    expect(result).toBe('<svg><text id="el-a">new</text></svg>');
  });

  it("recognises a closing tag with whitespace before the >, e.g. </text >", () => {
    const svg = '<svg><text id="el-a">old</text ></svg>';

    const result = replaceElementText(svg, "el-a", "new");

    expect(result).toBe('<svg><text id="el-a">new</text ></svg>');
  });

  it("throws when no genuine closing tag exists (only a comment mentioning it)", () => {
    const svg = '<svg><text id="el-a">old<!-- </text> --></svg>';

    expect(() => replaceElementText(svg, "el-a", "new")).toThrow();
  });

  // The attribute scanner closes a whole class of "id lookalike" defects
  // (three rounds of review each found a different way to fool a
  // text-searching match). These are the tricks found so far, plus the
  // obvious neighbours, proving there is no lookalike left to defend
  // against once the region is tokenised rather than searched.
  describe("attribute scanner closes the id-lookalike class", () => {
    it("does not select an element whose id attribute value is embedded inside another attribute's quoted value (double-quoted outer, id in single quotes)", () => {
      const svg = "<svg><text data-note=' id=\"el-a\"' id=\"el-b\">wrong</text><text id=\"el-a\">right</text></svg>";

      const result = replaceElementText(svg, "el-a", "new");

      expect(result).toBe(
        "<svg><text data-note=' id=\"el-a\"' id=\"el-b\">wrong</text><text id=\"el-a\">new</text></svg>",
      );
    });

    it("does not select an element whose id attribute value is embedded inside another attribute's quoted value (single-quoted outer, id in double quotes)", () => {
      const svg = '<svg><text data-note=" id=\'el-a\'" id="el-b">wrong</text><text id="el-a">right</text></svg>';

      const result = replaceElementText(svg, "el-a", "new");

      expect(result).toBe(
        '<svg><text data-note=" id=\'el-a\'" id="el-b">wrong</text><text id="el-a">new</text></svg>',
      );
    });

    it("still finds the tag end correctly when an attribute value contains a literal >", () => {
      const svg = '<svg><text data-note="a > b" id="el-a">old</text></svg>';

      const result = replaceElementText(svg, "el-a", "new");

      expect(result).toBe('<svg><text data-note="a > b" id="el-a">new</text></svg>');
    });

    it("matches id with whitespace around the =", () => {
      const svg = '<svg><text id = "el-a">old</text></svg>';

      const result = replaceElementText(svg, "el-a", "new");

      expect(result).toBe('<svg><text id = "el-a">new</text></svg>');
    });

    it("matches a single-quoted id attribute", () => {
      const svg = "<svg><text id='el-a'>old</text></svg>";

      const result = replaceElementText(svg, "el-a", "new");

      expect(result).toBe("<svg><text id='el-a'>new</text></svg>");
    });

    it("throws when the id appears only inside a CDATA section (never scanned as markup)", () => {
      const svg = '<svg><![CDATA[<text id="el-a">old</text>]]></svg>';

      expect(() => replaceElementText(svg, "el-a", "new")).toThrow();
    });

    it("throws an explicit error on malformed attribute syntax rather than guessing (unquoted value)", () => {
      const svg = '<svg><text id=el-a>old</text></svg>';

      expect(() => replaceElementText(svg, "el-a", "new")).toThrow();
    });
  });
});

// #72's conversion moves `id` up from a primitive onto its wrapping `<g>`
// container (ADR-0012). This is the red-light fix: without it, `text set`
// on any converted slide reports "元素不是文字元素" because the id sits on
// the `<g>`, not the `<text>`.
describe("replaceElementText — id on a <g> container wrapping a <text> child", () => {
  it("descends into the container and edits its single <text> child, leaving the container's own attributes untouched", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
      '  <g id="el-title" data-comot-name="標題"><text x="640" y="360" text-anchor="middle" font-size="48">驗收用簡報</text></g>\n' +
      "</svg>\n";

    const result = replaceElementText(svg, "el-title", "改過的標題");

    expect(result).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
        '  <g id="el-title" data-comot-name="標題"><text x="640" y="360" text-anchor="middle" font-size="48">改過的標題</text></g>\n' +
        "</svg>\n",
    );
  });

  it("throws when the container has no <text> child (e.g. it wraps a <rect>)", () => {
    const svg = '<svg><g id="el-a"><rect x="0" y="0" width="1" height="1"></rect></g></svg>';

    expect(() => replaceElementText(svg, "el-a", "new")).toThrow("元素不是文字元素：el-a");
  });

  it("throws when the container has more than one direct <text> child (ambiguous which one is 'the' text)", () => {
    const svg = '<svg><g id="el-a"><text>a</text><text>b</text></g></svg>';

    expect(() => replaceElementText(svg, "el-a", "new")).toThrow("元素不是文字元素：el-a");
  });

  it("throws when the container holds a nested <g> group rather than a single primitive", () => {
    const svg = '<svg><g id="el-a"><g><text>a</text></g></g></svg>';

    expect(() => replaceElementText(svg, "el-a", "new")).toThrow("元素不是文字元素：el-a");
  });
});

describe("substituteDynamicText", () => {
  it("replaces a known variable inside a plain <text> element", () => {
    const svg = '<svg><text id="el-a">第 {{ slide_number }} 頁</text></svg>';

    const result = substituteDynamicText(svg, new Map([["slide_number", "3"]]));

    expect(result).toBe('<svg><text id="el-a">第 3 頁</text></svg>');
  });

  it("replaces multiple distinct variables, each with its own value", () => {
    const svg = '<svg><text id="el-a">{{ slide_number }} / {{ slide_total }}</text></svg>';

    const result = substituteDynamicText(
      svg,
      new Map([
        ["slide_number", "2"],
        ["slide_total", "5"],
      ]),
    );

    expect(result).toBe('<svg><text id="el-a">2 / 5</text></svg>');
  });

  it("replaces the same variable every time it appears", () => {
    const svg = '<svg><text id="el-a">{{ slide_number }}-{{ slide_number }}</text></svg>';

    const result = substituteDynamicText(svg, new Map([["slide_number", "1"]]));

    expect(result).toBe('<svg><text id="el-a">1-1</text></svg>');
  });

  it("tolerates extra whitespace inside the braces", () => {
    const svg = "<svg><text id=\"el-a\">{{   slide_number   }}</text></svg>";

    const result = substituteDynamicText(svg, new Map([["slide_number", "7"]]));

    expect(result).toBe('<svg><text id="el-a">7</text></svg>');
  });

  it("leaves an unknown variable name exactly as written", () => {
    const svg = '<svg><text id="el-a">{{ mystery }}</text></svg>';

    const result = substituteDynamicText(svg, new Map([["slide_number", "1"]]));

    expect(result).toBe('<svg><text id="el-a">{{ mystery }}</text></svg>');
  });

  it("leaves an unmatched '{{' exactly as written, without throwing", () => {
    const svg = '<svg><text id="el-a">use {{ like this</text></svg>';

    const result = substituteDynamicText(svg, new Map([["slide_number", "1"]]));

    expect(result).toBe('<svg><text id="el-a">use {{ like this</text></svg>');
  });

  it("leaves text with no placeholders completely untouched", () => {
    const svg = '<svg><text id="el-a">plain text</text></svg>';

    const result = substituteDynamicText(svg, new Map([["slide_number", "1"]]));

    expect(result).toBe(svg);
  });

  it("substitutes independently inside each <tspan> of a text box, leaving other lines untouched", () => {
    const svg =
      '<svg><g id="el-a" data-comot-text-width="200">' +
      '<text font-family="Noto" font-size="16">' +
      '<tspan x="0" dy="0">line {{ slide_number }}</tspan>' +
      '<tspan x="0" dy="20">of {{ slide_total }}</tspan>' +
      "</text></g></svg>";

    const result = substituteDynamicText(
      svg,
      new Map([
        ["slide_number", "1"],
        ["slide_total", "4"],
      ]),
    );

    expect(result).toBe(
      '<svg><g id="el-a" data-comot-text-width="200">' +
        '<text font-family="Noto" font-size="16">' +
        '<tspan x="0" dy="0">line 1</tspan>' +
        '<tspan x="0" dy="20">of 4</tspan>' +
        "</text></g></svg>",
    );
  });

  it("substitutes a value that itself contains escaped XML entities verbatim", () => {
    const svg = '<svg><text id="el-a">{{ presentation_name }}</text></svg>';

    const result = substituteDynamicText(svg, new Map([["presentation_name", "A &amp; B"]]));

    expect(result).toBe('<svg><text id="el-a">A &amp; B</text></svg>');
  });
});

// NOOP-129 Review round-1 FAIL item 2: Plan §6.4 promised these 4 tests and
// none were written — a mutation check proved `rewrapTextBoxContent` /
// `replaceContainerText` / `setTextRunStyle` can each drop their
// `data-comot-text-height` write with all 1076 unit tests staying green.
// Every expected height below comes from the font's own hhea fields via the
// documented lineHeight formula (`text-wrap.test.ts`'s own convention),
// never from calling `wrapText`/`rewrapTextBoxContent` a second time — so a
// height genuinely computed wrong would fail these too, not just a height
// that was never written.
describe("data-comot-text-height tracks every rewrap path (NOOP-65 決定 C)", () => {
  let font: FontMetrics;
  let fontBook: ReadonlyMap<string, FontMetrics>;
  let expectedLineHeight: number;
  const FONT_SIZE = 40;

  beforeAll(async () => {
    font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fontBook = new Map([[FAMILY, font]]);
    expectedLineHeight = ((font.ascender - font.descender + font.lineGap) / font.unitsPerEm) * FONT_SIZE;
  });

  it("resizeTextBox (textbox width) rewrites the height when narrowing forces 1 line into 3", () => {
    const elementId = "el-height-1";
    const wideWidth = measureTextWidth(font, CHAR.repeat(9), FONT_SIZE);
    const narrowWidth = measureTextWidth(font, CHAR.repeat(3), FONT_SIZE);
    const original = buildTextBoxSvg(elementId, CHAR.repeat(9), wideWidth, FONT_SIZE, font);
    expect(heightOf(original)).toBeCloseTo(expectedLineHeight, 4);

    const { updated, lines } = resizeTextBox(original, elementId, narrowWidth, fontBook);
    expect(lines).toBe(3);
    expect(heightOf(updated)).toBeCloseTo(3 * expectedLineHeight, 4);
  });

  it("replaceElementText (text set) rewrites the height for the NEW content, not the old one", () => {
    const elementId = "el-height-2";
    const width = measureTextWidth(font, CHAR.repeat(9), FONT_SIZE);
    const original = buildTextBoxSvg(elementId, CHAR.repeat(3), width, FONT_SIZE, font);
    expect(heightOf(original)).toBeCloseTo(expectedLineHeight, 4);

    // 27 identical chars at a width sized for exactly 9 wrap to exactly 3 lines.
    const updated = replaceElementText(original, elementId, CHAR.repeat(27), { fontBook });
    expect(heightOf(updated)).toBeCloseTo(3 * expectedLineHeight, 4);
  });

  it("setTextRunStyle (text style set) bakes a first-time height onto a legacy box that had none yet (§4.5 compatibility)", () => {
    const elementId = "el-height-3";
    const width = measureTextWidth(font, CHAR.repeat(9), FONT_SIZE);
    const legacy = buildLegacyTextBoxSvg(elementId, CHAR.repeat(9), width, FONT_SIZE, font);
    expect(legacy).not.toContain("data-comot-text-height");

    const { updated } = setTextRunStyle(legacy, elementId, 0, 1, { fontWeight: "bold" }, fontBook);
    expect(heightOf(updated)).toBeCloseTo(expectedLineHeight, 4);
  });

  it("bakes a first-time data-comot-text-height AFTER id/data-comot-text-width, never reordered ahead of them (splice-order regression)", () => {
    const elementId = "el-height-4";
    const width = measureTextWidth(font, CHAR.repeat(9), FONT_SIZE);
    const legacy = buildLegacyTextBoxSvg(elementId, CHAR.repeat(9), width, FONT_SIZE, font);

    const { updated } = resizeTextBox(legacy, elementId, width, fontBook);
    const openTag = /<g[^>]*>/.exec(updated)![0];
    expect(openTag).toMatch(
      new RegExp(`^<g id="${elementId}" data-comot-text-width="[^"]+" data-comot-text-height="[^"]+">$`),
    );
  });
});

// NOOP-129 Review round-1 FAIL item 3: `readTextAlign` documents itself as
// an already-decided contract ("every rewrap path calls this to carry the
// box's alignment forward unchanged"), but nothing failed when it was
// mutated to always return "left". Expected `x` values below come from the
// §7-D formula applied to independently measured line widths
// (`measureTextWidth`), never from calling `wrapText` a second time.
describe("data-comot-text-align is carried forward through every rewrap path (NOOP-65 決定 D)", () => {
  let font: FontMetrics;
  let fontBook: ReadonlyMap<string, FontMetrics>;
  const FONT_SIZE = 40;

  beforeAll(async () => {
    font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fontBook = new Map([[FAMILY, font]]);
  });

  it("resizeTextBox (textbox width) keeps center alignment: every line's x stays (width-lineWidth)/2, not 0", () => {
    const elementId = "el-align-1";
    const charWidth = measureTextWidth(font, CHAR, FONT_SIZE);
    const width1 = charWidth * 9;
    const width2 = charWidth * 5;
    const original = buildTextBoxSvg(elementId, CHAR.repeat(9), width1, FONT_SIZE, font, { align: "center" });

    const { updated, lines } = resizeTextBox(original, elementId, width2, fontBook);
    expect(lines).toBe(2);
    expect(updated).toContain('data-comot-text-align="center"');

    const xs = Array.from(updated.matchAll(/<tspan x="([-0-9.]+)"/g)).map((m) => Number(m[1]));
    expect(xs).toHaveLength(2);
    const line1Width = measureTextWidth(font, CHAR.repeat(5), FONT_SIZE);
    const line2Width = measureTextWidth(font, CHAR.repeat(4), FONT_SIZE);
    expect(xs[0]).toBeCloseTo((width2 - line1Width) / 2, 4);
    expect(xs[1]).toBeCloseTo((width2 - line2Width) / 2, 4);
  });

  it("replaceElementText (text set) keeps right alignment on the freshly wrapped new content", () => {
    const elementId = "el-align-2";
    const charWidth = measureTextWidth(font, CHAR, FONT_SIZE);
    const width = charWidth * 8;
    const original = buildTextBoxSvg(elementId, CHAR.repeat(2), width, FONT_SIZE, font, { align: "right" });

    const updated = replaceElementText(original, elementId, CHAR.repeat(6), { fontBook });
    expect(updated).toContain('data-comot-text-align="right"');

    const x = Number(/<tspan x="([-0-9.]+)"/.exec(updated)![1]);
    const lineWidth = measureTextWidth(font, CHAR.repeat(6), FONT_SIZE);
    expect(x).toBeCloseTo(width - lineWidth, 4);
    expect(x).not.toBe(0);
  });
});
