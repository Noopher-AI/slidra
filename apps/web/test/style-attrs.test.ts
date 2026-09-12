import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSlide, type SlideElement } from "../src/slide-dom.js";
import { PANEL_STYLE_ATTRIBUTES, readElementStyle, summarizeSelection } from "../src/style-attrs.js";

// The web bundle no longer depends on core's command-layer whitelist at
// all — this reads the normative source, `docs/spec/cli.md`'s own
// `element style set` entry, with node:fs + regex instead (same
// "the file's own text is the contract" posture `tokens.test.ts` already
// applies elsewhere).
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliSpecPath = path.join(repoRoot, "docs", "spec", "cli.md");
const cliSpec = readFileSync(cliSpecPath, "utf8");

function styleAttributeWhitelist(): string[] {
  const match = cliSpec.match(/`attr`：必填，位置參數，必須落在白名單內（ADR-0014）：([^。]+)。/);
  if (!match) throw new Error("cli.md 找不到 element style set 的 attr 白名單描述");
  return [...match[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
}

const wrap = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n${body}\n</svg>\n`;

function elementOf(svgBody: string, id: string): SlideElement {
  const model = parseSlide(wrap(svgBody));
  const found = model.elements.find((element) => element.id === id);
  if (!found) throw new Error(`fixture 裡沒有 id=${id} 的元素`);
  return found;
}

describe("PANEL_STYLE_ATTRIBUTES (anti-drift: every attribute name the segmented panel sends to `element style set` is in the whitelist)", () => {
  it("every attribute is within the `element style set` whitelist in docs/spec/cli.md", () => {
    const whitelist = styleAttributeWhitelist();
    for (const attr of PANEL_STYLE_ATTRIBUTES) {
      expect(whitelist).toContain(attr);
    }
  });

  it("is the fixed set: fill / stroke / stroke-width / font-family / font-size / font-weight / text-anchor / opacity", () => {
    expect(PANEL_STYLE_ATTRIBUTES).toEqual([
      "fill",
      "stroke",
      "stroke-width",
      "font-family",
      "font-size",
      "font-weight",
      "text-anchor",
      "opacity",
    ]);
  });
});

describe("readElementStyle", () => {
  it("a group container (with no primitives) returns unset", () => {
    const element = elementOf('<g id="el-group"><g id="el-child"><rect x="0" y="0" width="1" height="1"/></g></g>', "el-group");
    expect(readElementStyle(element, "fill")).toEqual({ kind: "unset" });
  });

  it("no primitive has this attribute → unset, without fabricating an SVG default value", () => {
    const element = elementOf('<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>', "el-a");
    expect(readElementStyle(element, "stroke")).toEqual({ kind: "unset" });
  });

  it("a single primitive, or multiple primitives with the same value → the literal string, unnormalized", () => {
    const single = elementOf('<g id="el-a"><rect x="0" y="0" width="1" height="1" opacity="1.0"/></g>', "el-a");
    expect(readElementStyle(single, "opacity")).toEqual({ kind: "value", value: "1.0" });

    const multi = elementOf(
      '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#FFF"/><circle cx="0" cy="0" r="1" fill="#FFF"/></g>',
      "el-a",
    );
    expect(readElementStyle(multi, "fill")).toEqual({ kind: "value", value: "#FFF" });
  });

  it("multiple primitives with differing values → mixed", () => {
    const element = elementOf(
      '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/><circle cx="0" cy="0" r="1" fill="#222"/></g>',
      "el-a",
    );
    expect(readElementStyle(element, "fill")).toEqual({ kind: "mixed" });
  });

  it("some primitives have a value and some don't → mixed", () => {
    const element = elementOf(
      '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/><circle cx="0" cy="0" r="1"/></g>',
      "el-a",
    );
    expect(readElementStyle(element, "fill")).toEqual({ kind: "mixed" });
  });
});

describe("summarizeSelection", () => {
  it("an empty array → unset", () => {
    expect(summarizeSelection([], "fill")).toEqual({ kind: "unset" });
  });

  it("every element has the same value → that shared value", () => {
    const a = elementOf('<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#c43e1c"/></g>', "el-a");
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#c43e1c"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1" fill="#c43e1c"/></g>',
      ),
    );
    const b = model.elements.find((element) => element.id === "el-b")!;
    expect(summarizeSelection([a, b], "fill")).toEqual({ kind: "value", value: "#c43e1c" });
  });

  it("every element is unset → unset", () => {
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>',
      ),
    );
    const [a, b] = model.elements;
    expect(summarizeSelection([a, b], "stroke")).toEqual({ kind: "unset" });
  });

  it("elements differ in value → mixed", () => {
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1" fill="#222"/></g>',
      ),
    );
    const [a, b] = model.elements;
    expect(summarizeSelection([a, b], "fill")).toEqual({ kind: "mixed" });
  });

  it("value and unset coexist → mixed", () => {
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>',
      ),
    );
    const [a, b] = model.elements;
    expect(summarizeSelection([a, b], "fill")).toEqual({ kind: "mixed" });
  });

  it("any element that is internally mixed makes the whole selection mixed", () => {
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/><circle cx="0" cy="0" r="1" fill="#222"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1" fill="#111"/></g>',
      ),
    );
    const [a, b] = model.elements;
    expect(summarizeSelection([a, b], "fill")).toEqual({ kind: "mixed" });
  });
});
