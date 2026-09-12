import { describe, expect, it } from "vitest";
import { parseSlide } from "../src/slide-dom.js";

/**
 * The web bundle's own DOMParser-based `parseSlide`, replacing core's
 * byte-offset slide/format.ts parseSlide.
 * Tested at its own public boundary — a slide markup string in, a
 * `SlideModel` out — the same way canvas.ts's own tests treat it.
 */

const SVG_WITH_GROUP_TEXTBOX_TABLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
  '<g id="el-group">' +
  '<g id="el-rect"><rect x="0" y="0" width="10" height="10"/></g>' +
  "</g>" +
  '<g id="el-textbox" data-slidra-text-width="400" data-slidra-text-align="center">' +
  '<text font-family="Noto Sans TC" font-size="16"><tspan x="0" y="16">Hi</tspan></text>' +
  "</g>" +
  '<g id="el-table" data-slidra-type="table" data-slidra-cols="100 100" data-slidra-rows="40 40">' +
  '<g data-slidra-cell="0,0"><rect width="100" height="40" fill="#111111"/><text x="0" y="0"><tspan>a</tspan></text></g>' +
  '<g data-slidra-cell="0,1"><rect width="100" height="40" fill="#222222"/><text x="0" y="0"><tspan>b</tspan></text></g>' +
  '<g data-slidra-cell="1,0"><rect width="100" height="40" fill="#333333"/><text x="0" y="0"><tspan>c</tspan></text></g>' +
  '<g data-slidra-cell="1,1"><rect width="100" height="40" fill="#444444"/><text x="0" y="0"><tspan>d</tspan></text></g>' +
  "</g>" +
  "</svg>";

describe("parseSlide", () => {
  it("a slide with a group/textbox/table → produces the correct model shape", () => {
    const model = parseSlide(SVG_WITH_GROUP_TEXTBOX_TABLE);

    expect(model.viewBox).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(model.elements.map((e) => e.id)).toEqual(["el-group", "el-textbox", "el-table"]);

    const group = model.elements[0];
    expect(group.kind).toBe("group");
    expect(group.children.map((c) => c.id)).toEqual(["el-rect"]);
    expect(group.children[0].kind).toBe("rect");

    const textbox = model.elements[1];
    expect(textbox.kind).toBe("text");
    expect(textbox.textWidth).toBe(400);
    expect(textbox.textAlign).toBe("center");
    expect(textbox.primitives[0].text).toBe("Hi");

    const table = model.elements[2];
    expect(table.kind).toBe("table");
    expect(table.table).not.toBeNull();
    expect(table.table!.cols).toEqual([100, 100]);
    expect(table.table!.rows).toEqual([40, 40]);
    expect(table.table!.cells).toHaveLength(4);
    const cellA = table.table!.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(cellA.text).toBe("a");
    expect(cellA.fill).toBe("#111111");
  });

  it("throws when markup fails to parse (not valid XML / no <svg> root), letting the caller (canvas.ts's existing try/catch) degrade to null", () => {
    expect(() => parseSlide("<svg><g></svg>")).toThrow();
    expect(() => parseSlide("<html><body>not a slide</body></html>")).toThrow();
    expect(() => parseSlide('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toThrow(); // no viewBox
  });

  it("an invalid data-slidra-text-width (non-positive) leaves that element's textWidth as null — it only affects that one element, unlike core's write path which throws, so it never fails parsing the whole slide", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<g id="el-a" data-slidra-text-width="not-a-number"><text>Hi</text></g>' +
      '<g id="el-b" data-slidra-text-width="0"><text>Bye</text></g>' +
      "</svg>";
    const model = parseSlide(svg);
    expect(model.elements.find((e) => e.id === "el-a")!.textWidth).toBeNull();
    expect(model.elements.find((e) => e.id === "el-b")!.textWidth).toBeNull();
  });

  it("reads backgroundImage's asset (stripping ../) and opacity when a background image is present", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<g id="el-background" data-slidra-role="background" data-slidra-lock="true">' +
      '<image x="0" y="0" width="1280" height="720" href="../assets/bg.svg" opacity="0.5"/>' +
      "</g>" +
      "</svg>";
    const model = parseSlide(svg);
    expect(model.backgroundImage).toEqual({ asset: "assets/bg.svg", opacity: 0.5 });
  });

  it("backgroundImage is null when there is no background image", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>';
    expect(parseSlide(svg).backgroundImage).toBeNull();
  });
});
