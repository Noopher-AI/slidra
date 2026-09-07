import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  assertSlideCompliant,
  checkSlideCompliance,
  parseSlide,
} from "../src/slide/format.js";
import { normaliseSlideSvg } from "../src/slide/normalise.js";

const demoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../demo");

/** A counter, not a random source: a test asserting exact bytes needs predictable identifiers. */
function sequentialIds(prefix = "el-gen"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const wrap = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n${body}\n</svg>\n`;

describe("checkSlideCompliance", () => {
  it("finds nothing wrong with a slide already in the normal form", () => {
    expect(checkSlideCompliance(wrap('  <g id="el-a"><rect x="0" y="0" width="10" height="10"/></g>'))).toEqual([]);
  });

  it("reports a bare primitive at the line and column of its own tag", () => {
    const issues = checkSlideCompliance(wrap('  <rect x="0" y="0" width="10" height="10"/>'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "bare-primitive", line: 2, column: 3, tag: "rect" });
    expect(issues[0].message).toBe(
      "<rect> 是裸圖元，必須包在 <g> 容器裡。請執行 co-motion convert <簡報識別碼> 轉換成合規格式。",
    );
  });

  it("rejects <script> anywhere, and says conversion will not remove it", () => {
    const issues = checkSlideCompliance(wrap("  <metadata><script>alert(1)</script></metadata>"));
    expect(issues.map((issue) => issue.code)).toContain("forbidden-tag");
    expect(issues[0].message).toBe("<script> 不是合法元素，轉換命令不會替你移除，請自行刪除後再轉換。");
  });

  it("rejects <foreignObject>", () => {
    const issues = checkSlideCompliance(wrap('  <g id="el-a"><foreignObject width="1" height="1"/></g>'));
    expect(issues.map((issue) => issue.code)).toContain("forbidden-tag");
  });

  it("rejects <polygon>, <polyline> and <use>, suggesting <path> instead", () => {
    for (const tag of ["polygon", "polyline", "use"]) {
      const issues = checkSlideCompliance(wrap(`  <g id="el-a"><${tag}/></g>`));
      expect(issues.map((issue) => issue.code)).toContain("unknown-tag");
      expect(issues.find((issue) => issue.code === "unknown-tag")!.message).toContain("<path>");
    }
  });

  it("reports a container with no id", () => {
    const issues = checkSlideCompliance(wrap('  <g><rect width="1" height="1"/></g>'));
    expect(issues[0]).toMatchObject({ code: "missing-id", line: 2, column: 3 });
  });

  it("reports a duplicate id, naming it", () => {
    const issues = checkSlideCompliance(
      wrap('  <g id="el-a"><rect width="1" height="1"/></g>\n  <g id="el-a"><rect width="1" height="1"/></g>'),
    );
    expect(issues[0]).toMatchObject({ code: "duplicate-id", line: 3, elementId: "el-a" });
  });

  it("reports an empty container", () => {
    const issues = checkSlideCompliance(wrap('  <g id="el-a"></g>'));
    expect(issues[0]).toMatchObject({ code: "empty-container", elementId: "el-a" });
  });

  it("reports a container holding both a primitive and a child container", () => {
    const issues = checkSlideCompliance(
      wrap('  <g id="el-title"><rect width="1" height="1"/><g id="el-b"><rect width="1" height="1"/></g></g>'),
    );
    expect(issues[0]).toMatchObject({ code: "mixed-children", elementId: "el-title" });
    expect(issues[0].message).toBe("容器 el-title 同時含有圖元與子容器，容器只能二擇一。");
  });

  it("reports a transform written on the primitive instead of the container", () => {
    const issues = checkSlideCompliance(
      wrap('  <g id="el-a"><rect transform="translate(1 2)" width="1" height="1"/></g>'),
    );
    expect(issues[0]).toMatchObject({ code: "primitive-transform", tag: "rect" });
  });

  it("reports a container transform it cannot parse", () => {
    const issues = checkSlideCompliance(
      wrap('  <g id="el-a" transform="wobble(3)"><rect width="1" height="1"/></g>'),
    );
    expect(issues[0]).toMatchObject({ code: "bad-transform", elementId: "el-a" });
  });

  it("accepts an empty transform attribute: an empty transform-list is legal SVG", () => {
    expect(checkSlideCompliance(wrap('  <g id="el-a" transform=""><rect width="1" height="1"/></g>'))).toEqual([]);
  });

  it("reports a missing viewBox", () => {
    const issues = checkSlideCompliance(
      '<svg xmlns="http://www.w3.org/2000/svg">\n  <g id="el-a"><rect width="1" height="1"/></g>\n</svg>\n',
    );
    expect(issues[0]).toMatchObject({ code: "missing-viewbox" });
  });

  it("reports unterminated markup instead of guessing where the tag ended", () => {
    const issues = checkSlideCompliance('<svg viewBox="0 0 1 1">\n  <g id="el-a">\n</svg>\n');
    expect(issues[0].code).toBe("malformed-markup");
  });

  it("leaves <defs>, <style>, <metadata>, <title> and <desc> alone: they are not elements", () => {
    expect(
      checkSlideCompliance(
        wrap(
          "  <defs><linearGradient id=\"g1\"/></defs>\n" +
            '  <metadata><comot:effects xmlns:comot="https://co-motion.dev/ns">' +
            '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/></comot:effects></metadata>\n' +
            '  <g id="el-a"><rect width="1" height="1"/></g>',
        ),
      ),
    ).toEqual([]);
  });

  it("accepts <tspan> inside <text>: #76's line breaking writes them", () => {
    expect(checkSlideCompliance(wrap('  <g id="el-a"><text><tspan>一</tspan><tspan>二</tspan></text></g>'))).toEqual([]);
  });

  it("does not police on* attributes: that defence is the iframe sandbox (ADR-0010/0011)", () => {
    expect(checkSlideCompliance(wrap('  <g id="el-a"><rect onload="x()" width="1" height="1"/></g>'))).toEqual([]);
  });

  it("does not care that a primitive would paint nothing: compliance is about structure", () => {
    expect(checkSlideCompliance(wrap('  <g id="el-a"><rect x="0"/></g>'))).toEqual([]);
  });

  it("accepts an id that does not start with el-: only non-empty and unique are required", () => {
    expect(checkSlideCompliance(wrap('  <g id="whatever"><rect width="1" height="1"/></g>'))).toEqual([]);
  });

  // E2.T12 §3.1 — before this branch existed, the chart container shape
  // died here with two `unknown-tag` issues (`<comot:chart>` and `<svg>`).
  it("accepts a chart container: data-comot-type=\"chart\" holding <comot:chart> and <svg>", () => {
    const issues = checkSlideCompliance(
      wrap(
        '  <g id="el-chart" data-comot-type="chart" transform="translate(0 0)">' +
          '<comot:chart xmlns:comot="https://co-motion.dev/ns" type="bar"/>' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"></svg>' +
          "</g>",
      ),
    );
    expect(issues).toEqual([]);
  });

  it("still rejects a bare <svg> outside a data-comot-type=\"chart\" container", () => {
    const issues = checkSlideCompliance(
      wrap('  <g id="el-a"><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg></g>'),
    );
    expect(issues.map((issue) => issue.code)).toContain("unknown-tag");
  });

  it("reports invalid-chart-shape when a chart container is missing its <comot:chart> or its <svg>", () => {
    const missingSvg = checkSlideCompliance(
      wrap(
        '  <g id="el-chart" data-comot-type="chart">' +
          '<comot:chart xmlns:comot="https://co-motion.dev/ns" type="bar"/>' +
          "</g>",
      ),
    );
    expect(missingSvg.map((issue) => issue.code)).toEqual(["invalid-chart-shape"]);

    const twoCharts = checkSlideCompliance(
      wrap(
        '  <g id="el-chart" data-comot-type="chart">' +
          '<comot:chart xmlns:comot="https://co-motion.dev/ns" type="bar"/>' +
          '<comot:chart xmlns:comot="https://co-motion.dev/ns" type="bar"/>' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>' +
          "</g>",
      ),
    );
    expect(twoCharts.map((issue) => issue.code)).toEqual(["invalid-chart-shape"]);
  });

  it("is not fooled by markup written inside a comment or a quoted attribute value", () => {
    expect(
      checkSlideCompliance(
        wrap(
          "  <!-- <rect width=\"1\" height=\"1\"/> -->\n" +
            '  <g id="el-a" data-note=\' id="el-b" \'><path d="M10 10 L20>20"/></g>',
        ),
      ),
    ).toEqual([]);
  });
});

describe("assertSlideCompliant", () => {
  it("names the slide, the line, the column and the offending tag", () => {
    expect(() => assertSlideCompliant(wrap('  <rect width="1" height="1"/>'), "slides/001.svg")).toThrow(
      "投影片 slides/001.svg 不合規（第 2 行第 3 欄）：<rect> 是裸圖元，必須包在 <g> 容器裡。" +
        "請執行 co-motion convert <簡報識別碼> 轉換成合規格式。",
    );
  });

  it("says how many further problems there are when there is more than one", () => {
    expect(() =>
      assertSlideCompliant(wrap('  <rect width="1" height="1"/>\n  <text>x</text>'), "slides/002.svg"),
    ).toThrow(/（另有 1 處問題）/);
  });

  it("passes silently on a compliant slide", () => {
    expect(() => assertSlideCompliant(wrap('  <g id="el-a"><rect width="1" height="1"/></g>'), "slides/001.svg")).not.toThrow();
  });
});

describe("parseSlide", () => {
  it("reads the viewBox and the container chain into a model", () => {
    const model = parseSlide(
      wrap(
        '  <g id="el-group" transform="translate(100 0)">\n' +
          '    <g id="el-a" data-comot-name="甲"><rect x="1" y="2" width="3" height="4"/></g>\n' +
          '    <g id="el-b" data-comot-media="../assets/a.oga"><circle cx="0" cy="0" r="5"/></g>\n' +
          "  </g>",
      ),
    );
    expect(model.viewBox).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(model.elements).toHaveLength(1);
    const group = model.elements[0];
    expect(group.kind).toBe("group");
    expect(group.transform).toBe("translate(100 0)");
    expect(group.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 });
    expect(group.children.map((child) => [child.id, child.kind, child.name, child.media])).toEqual([
      ["el-a", "rect", "甲", null],
      ["el-b", "circle", null, "../assets/a.oga"],
    ]);
  });

  // #200 §4.4: Page style lives on the root <svg>'s own `style` attribute,
  // read back into `SlideModel.pageStyle` — absent means both null, never a
  // fabricated default.
  it("reads pageStyle off the root <svg>'s style attribute, defaulting to both null when absent", () => {
    expect(parseSlide(wrap('<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>')).pageStyle).toEqual({
      background: null,
      accent: null,
    });

    const styled =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" style="background-color:#14161a;--comot-accent:#c41e3a">' +
      '<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g></svg>\n';
    expect(parseSlide(styled).pageStyle).toEqual({ background: "#14161a", accent: "#c41e3a" });
  });

  it("calls a container holding several primitives a compound element", () => {
    const model = parseSlide(wrap('  <g id="el-a"><circle cx="0" cy="0" r="1"/><path d="M0 0 L1 1"/></g>'));
    expect(model.elements[0].kind).toBe("compound");
    expect(model.elements[0].primitives.map((primitive) => primitive.tag)).toEqual(["circle", "path"]);
  });

  // NOOP-65r3 §2a — `textAlign`: absent defaults to "left" (every rewrap
  // path's own default, ADR-0017 決定 D), an explicit value reads back
  // verbatim, an illegal one throws with `readTextAlign`'s own wording, and
  // a non-text element gets the meaningless-but-present "left" default.
  it("reads data-comot-text-align into textAlign, defaulting to left, and rejects an illegal value", () => {
    const model = parseSlide(
      wrap(
        '  <g id="el-left"><text x="0" y="0"><tspan x="0" y="0">A</tspan></text></g>\n' +
          '  <g id="el-center" data-comot-text-align="center"><text x="0" y="0"><tspan x="0" y="0">A</tspan></text></g>\n' +
          '  <g id="el-right" data-comot-text-align="right"><text x="0" y="0"><tspan x="0" y="0">A</tspan></text></g>\n' +
          '  <g id="el-shape"><rect x="0" y="0" width="1" height="1"/></g>',
      ),
    );
    expect(model.elements.map((el) => [el.id, el.textAlign])).toEqual([
      ["el-left", "left"],
      ["el-center", "center"],
      ["el-right", "right"],
      ["el-shape", "left"],
    ]);

    expect(() =>
      parseSlide(
        wrap('  <g id="el-bad" data-comot-text-align="middle"><text x="0" y="0">A</text></g>'),
      ),
    ).toThrow(CoMotionError);
  });

  // NOOP-65r3 §2a — `SlidePrimitive.runs`: read back from nested run tspans
  // via the same `readTextBoxRuns` `rewrapTextBoxContent` uses (not a
  // second implementation); `[]` for a plain `<text>` and for every
  // non-text primitive.
  it("reads nested run tspans into a text primitive's runs", () => {
    const model = parseSlide(
      wrap(
        '  <g id="el-runs"><text x="0" y="0" xml:space="preserve">' +
          '<tspan x="0" y="10">粗<tspan font-weight="bold">體字</tspan></tspan>' +
          "</text></g>",
      ),
    );
    expect(model.elements[0].primitives[0].runs).toEqual([{ start: 1, end: 3, fontWeight: "bold" }]);
  });

  it("gives runs: [] to a plain <text> with no nested tspans, and to every non-text primitive", () => {
    const model = parseSlide(
      wrap(
        '  <g id="el-plain"><text x="0" y="0">plain</text></g>\n' +
          '  <g id="el-shape"><rect x="0" y="0" width="1" height="1"/></g>',
      ),
    );
    expect(model.elements[0].primitives[0].runs).toEqual([]);
    expect(model.elements[1].primitives[0].runs).toEqual([]);
  });

  // E2.T12 — `toElement`'s override: a chart container's kind is "chart"
  // even though it holds two children (`<comot:chart>` + `<svg>`), not the
  // generic "compound" a two-primitive container would otherwise get.
  it("gives a chart container kind: \"chart\", not \"compound\"", () => {
    const model = parseSlide(
      wrap(
        '  <g id="el-chart" data-comot-type="chart">' +
          '<comot:chart xmlns:comot="https://co-motion.dev/ns" type="bar"/>' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"></svg>' +
          "</g>",
      ),
    );
    expect(model.elements[0].kind).toBe("chart");
    expect(model.elements[0].primitives.map((primitive) => primitive.tag)).toEqual(["comot:chart", "svg"]);
  });

  it("refuses to model a non-compliant slide", () => {
    expect(() => parseSlide(wrap('  <rect width="1" height="1"/>'))).toThrow(CoMotionError);
  });
});

describe("normaliseSlideSvg", () => {
  it("wraps a bare primitive, moving id and 顯示名稱 onto the new container", () => {
    const result = normaliseSlideSvg(
      wrap('  <text id="el-title" data-comot-name="標題" x="640" y="330" font-size="86">驗收用簡報</text>'),
      { generateId: sequentialIds() },
    );
    expect(result.svg).toBe(
      wrap(
        '  <g id="el-title" data-comot-name="標題">\n' +
          '    <text x="640" y="330" font-size="86">驗收用簡報</text>\n' +
          "  </g>",
      ),
    );
    expect(result.wrapped).toBe(1);
    expect(result.generatedIds).toEqual([]);
  });

  it("mints an identifier for a primitive that has none, and invents no display name", () => {
    const result = normaliseSlideSvg(wrap('  <rect x="0" y="0" width="1280" height="720" fill="#101418"/>'), {
      generateId: sequentialIds(),
    });
    expect(result.svg).toBe(
      wrap('  <g id="el-gen-1">\n    <rect x="0" y="0" width="1280" height="720" fill="#101418"/>\n  </g>'),
    );
    expect(result.generatedIds).toEqual(["el-gen-1"]);
    expect(result.svg).not.toContain("data-comot-name");
  });

  // 裁決 6: player-plan.ts reads getElementById(target).getAttribute("data-comot-media").
  // If the attribute stays behind on the primitive while the id moves to the
  // container, every media cue on that element stops resolving.
  it("moves data-comot-media onto the container together with the id", () => {
    const result = normaliseSlideSvg(
      wrap(
        '  <rect id="el-video-placeholder" data-comot-name="影片" data-comot-media="../assets/intro.webm"' +
          ' x="240" y="220" width="400" height="300" fill="#3a4550"/>',
      ),
      { generateId: sequentialIds() },
    );
    expect(result.svg).toBe(
      wrap(
        '  <g id="el-video-placeholder" data-comot-name="影片" data-comot-media="../assets/intro.webm">\n' +
          '    <rect x="240" y="220" width="400" height="300" fill="#3a4550"/>\n' +
          "  </g>",
      ),
    );
  });

  it("moves a transform written on a bare primitive onto the container, verbatim", () => {
    const result = normaliseSlideSvg(
      wrap('  <rect id="el-a" transform="rotate(-15 10 10)" x="0" y="0" width="10" height="10"/>'),
      { generateId: sequentialIds() },
    );
    expect(result.svg).toBe(
      wrap(
        '  <g id="el-a" transform="rotate(-15 10 10)">\n' +
          '    <rect x="0" y="0" width="10" height="10"/>\n' +
          "  </g>",
      ),
    );
  });

  it("gives every primitive of a container its own container when one of them carries a transform", () => {
    const result = normaliseSlideSvg(
      wrap(
        '  <g id="el-pair">\n' +
          '    <rect transform="translate(5 5)" x="0" y="0" width="1" height="1"/>\n' +
          '    <circle cx="0" cy="0" r="1"/>\n' +
          "  </g>",
      ),
      { generateId: sequentialIds() },
    );
    expect(result.svg).toBe(
      wrap(
        '  <g id="el-pair">\n' +
          '    <g id="el-gen-1" transform="translate(5 5)">\n' +
          '      <rect x="0" y="0" width="1" height="1"/>\n' +
          "    </g>\n" +
          '    <g id="el-gen-2">\n' +
          '      <circle cx="0" cy="0" r="1"/>\n' +
          "    </g>\n" +
          "  </g>",
      ),
    );
    expect(result.wrapped).toBe(2);
  });

  it("is idempotent: converting an already-converted slide changes nothing", () => {
    const once = normaliseSlideSvg(
      wrap('  <rect x="0" y="0" width="1280" height="720"/>\n  <text id="el-t" x="1" y="2">甲</text>'),
      { generateId: sequentialIds() },
    );
    const twice = normaliseSlideSvg(once.svg, { generateId: sequentialIds("el-second") });
    expect(twice.svg).toBe(once.svg);
    expect(twice.wrapped).toBe(0);
    expect(twice.generatedIds).toEqual([]);
  });

  it("leaves the effect list and every other byte of the document untouched", () => {
    const original = wrap(
      "  <metadata>\n" +
        '    <comot:effects xmlns:comot="https://co-motion.dev/ns">\n' +
        '      <comot:effect target="el-step-one" family="enter" effect="fade" start="on-click"/>\n' +
        "    </comot:effects>\n" +
        "  </metadata>\n" +
        '  <text id="el-step-one" x="1" y="2">步驟一</text>',
    );
    const result = normaliseSlideSvg(original, { generateId: sequentialIds() });
    expect(result.svg).toBe(
      original.replace(
        '  <text id="el-step-one" x="1" y="2">步驟一</text>',
        '  <g id="el-step-one">\n    <text x="1" y="2">步驟一</text>\n  </g>',
      ),
    );
  });

  it("refuses to convert a slide containing <script>, and does not remove it", () => {
    expect(() =>
      normaliseSlideSvg(wrap('  <script>alert(1)</script>\n  <rect width="1" height="1"/>'), {
        generateId: sequentialIds(),
      }),
    ).toThrow(/<script> 不是合法元素/);
  });

  it("refuses to convert a slide containing an unknown tag", () => {
    expect(() =>
      normaliseSlideSvg(wrap('  <polygon points="0,0 1,1"/>'), { generateId: sequentialIds() }),
    ).toThrow(/不是合法的投影片元素/);
  });

  it("preserves a leading BOM as ordinary content", () => {
    const original = "﻿" + wrap('  <rect id="el-a" width="1" height="1"/>');
    const result = normaliseSlideSvg(original, { generateId: sequentialIds() });
    expect(result.svg.startsWith("﻿")).toBe(true);
  });
});

describe("normaliseSlideSvg against the real demo deck", () => {
  const readSlide = (name: string): Promise<string> => readFile(path.join(demoDir, "slides", name), "utf-8");

  // 裁決 7: demo/slides/004.svg's <g id="el-audio-icon"> was already a
  // compliant container before this ticket existed. Conversion touching it
  // at all would mean normalisation is rewriting things it has no business
  // rewriting.
  it("does not change a single byte of the already-compliant <g id=\"el-audio-icon\">", async () => {
    const original = await readSlide("004.svg");
    const audioIcon = original.slice(
      original.indexOf('<g id="el-audio-icon"'),
      original.indexOf("</g>", original.indexOf('<g id="el-audio-icon"')) + 4,
    );
    expect(audioIcon).toContain("<circle");
    const result = normaliseSlideSvg(original, { generateId: sequentialIds() });
    expect(result.svg).toContain(audioIcon);
  });

  it("leaves every <comot:effect target> in the demo deck pointing at the same identifier", async () => {
    for (const name of ["003.svg", "004.svg"]) {
      const original = await readSlide(name);
      const targets = [...original.matchAll(/<comot:effect target="([^"]+)"/g)].map((match) => match[1]);
      expect(targets.length).toBeGreaterThan(0);
      const converted = normaliseSlideSvg(original, { generateId: sequentialIds() }).svg;
      for (const target of targets) {
        expect(converted).toContain(`id="${target}"`);
        expect(converted).toContain(`<comot:effect target="${target}"`);
      }
    }
  });

  it("makes every demo slide compliant, and running it twice changes nothing further", async () => {
    for (const name of ["001.svg", "002.svg", "003.svg", "004.svg"]) {
      const original = await readSlide(name);
      const once = normaliseSlideSvg(original, { generateId: sequentialIds() });
      expect(checkSlideCompliance(once.svg)).toEqual([]);
      expect(normaliseSlideSvg(once.svg, { generateId: sequentialIds() }).svg).toBe(once.svg);
    }
  });
});
