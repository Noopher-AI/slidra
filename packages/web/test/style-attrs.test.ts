import { describe, expect, it } from "vitest";
import { parseSlide, type SlideElement } from "@co-motion/core/slide";
import { STYLE_ATTRIBUTE_WHITELIST } from "@co-motion/core";
import { PANEL_STYLE_ATTRIBUTES, readElementStyle, summarizeSelection } from "../src/style-attrs.js";

/**
 * `packages/core/src/element-edit.ts`'s own `FORBIDDEN_STYLE_ATTRIBUTES` —
 * not exported (it is a module-private const), so this list is copied here
 * verbatim for the drift check below. If the command layer ever adds a
 * sixth forbidden attribute this test still passes on the panel's *current*
 * eight, which is fine: the meaningful direction of drift this test guards
 * against is the panel silently offering something the command layer would
 * reject, and that only happens if this literal list goes stale in a way
 * that hides an entry the panel actually offers.
 */
const FORBIDDEN_GEOMETRY_ATTRIBUTES = ["transform", "x", "y", "width", "height"];

const wrap = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n${body}\n</svg>\n`;

function elementOf(svgBody: string, id: string): SlideElement {
  const model = parseSlide(wrap(svgBody));
  const found = model.elements.find((element) => element.id === id);
  if (!found) throw new Error(`fixture 裡沒有 id=${id} 的元素`);
  return found;
}

describe("PANEL_STYLE_ATTRIBUTES（驗收 L：反漂移）", () => {
  it("八格全部落在命令層的 STYLE_ATTRIBUTE_WHITELIST 之內", () => {
    for (const attr of PANEL_STYLE_ATTRIBUTES) {
      expect(STYLE_ATTRIBUTE_WHITELIST).toContain(attr);
    }
  });

  it("八格與白名單外的五個幾何屬性交集為空", () => {
    for (const attr of PANEL_STYLE_ATTRIBUTES) {
      expect(FORBIDDEN_GEOMETRY_ATTRIBUTES).not.toContain(attr);
    }
  });

  it("固定八格，且不含 stroke-dasharray（父票沒列，本票不做）", () => {
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

describe("readElementStyle（§4.2）", () => {
  it("群組容器（primitives 為空）回 unset", () => {
    const element = elementOf('<g id="el-group"><g id="el-child"><rect x="0" y="0" width="1" height="1"/></g></g>', "el-group");
    expect(readElementStyle(element, "fill")).toEqual({ kind: "unset" });
  });

  it("所有 primitive 都沒有這個屬性 → unset，不捏 SVG 預設值", () => {
    const element = elementOf('<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>', "el-a");
    expect(readElementStyle(element, "stroke")).toEqual({ kind: "unset" });
  });

  it("所有 primitive 值相同 → 原文字串，不正規化", () => {
    const element = elementOf('<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#FFF"/></g>', "el-a");
    expect(readElementStyle(element, "fill")).toEqual({ kind: "value", value: "#FFF" });
  });

  it("單一 primitive 的值就是它本身", () => {
    const element = elementOf('<g id="el-a"><rect x="0" y="0" width="1" height="1" opacity="1.0"/></g>', "el-a");
    expect(readElementStyle(element, "opacity")).toEqual({ kind: "value", value: "1.0" });
  });

  it("多個 primitive 之間值不同 → mixed", () => {
    const element = elementOf(
      '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/><circle cx="0" cy="0" r="1" fill="#222"/></g>',
      "el-a",
    );
    expect(readElementStyle(element, "fill")).toEqual({ kind: "mixed" });
  });

  it("部分 primitive 有值、部分沒有 → mixed", () => {
    const element = elementOf(
      '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/><circle cx="0" cy="0" r="1"/></g>',
      "el-a",
    );
    expect(readElementStyle(element, "fill")).toEqual({ kind: "mixed" });
  });
});

describe("summarizeSelection（§4.3）", () => {
  it("空陣列 → unset", () => {
    expect(summarizeSelection([], "fill")).toEqual({ kind: "unset" });
  });

  it("每個元素都是同一個值 → 該共同值", () => {
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

  it("每個元素都 unset → unset", () => {
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>',
      ),
    );
    const [a, b] = model.elements;
    expect(summarizeSelection([a, b], "stroke")).toEqual({ kind: "unset" });
  });

  it("元素之間值不同 → mixed", () => {
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1" fill="#222"/></g>',
      ),
    );
    const [a, b] = model.elements;
    expect(summarizeSelection([a, b], "fill")).toEqual({ kind: "mixed" });
  });

  it("value 與 unset 並存 → mixed", () => {
    const model = parseSlide(
      wrap(
        '<g id="el-a"><rect x="0" y="0" width="1" height="1" fill="#111"/></g>\n' +
          '<g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>',
      ),
    );
    const [a, b] = model.elements;
    expect(summarizeSelection([a, b], "fill")).toEqual({ kind: "mixed" });
  });

  it("任一元素本身內部 mixed → 整體 mixed", () => {
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
