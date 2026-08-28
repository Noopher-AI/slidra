import { describe, expect, it } from "vitest";
import { replaceElementText } from "../src/element-text.js";

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
