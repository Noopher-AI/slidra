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
});
