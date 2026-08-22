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
});
