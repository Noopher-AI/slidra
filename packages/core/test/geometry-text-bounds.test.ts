import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { elementBounds } from "../src/geometry/bbox.js";
import { parseTransform } from "../src/geometry/transform.js";
import { parseSlide } from "../src/slide/format.js";
import { measureTextWidth, parseFont, type FontMetrics } from "../src/text-metrics.js";

/**
 * `<text>` 的邊界框（NOOP-91 §4.7）。沒傳 `fonts` 時必須維持既有的拋錯行為，
 * 傳了才算得出來。期望值來自 hhea 度量的手算式與 `measureTextWidth` 本身，
 * 不是把 `elementBounds` 自己的輸出存下來當標準答案。
 */

const FAMILY = "Noto Sans TC";
const bundledFontPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/assets/fonts/NotoSansTC-Presentation.ttf",
);

function slide(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${inner}</svg>`;
}

describe("elementBounds 的 <text> 支援", () => {
  let font: FontMetrics;
  let fonts: ReadonlyMap<string, FontMetrics>;
  /** hhea 行高／基線，與 text/wrap.ts 的規則同一條式子。 */
  let lineHeightAt: (size: number) => number;
  let ascentAt: (size: number) => number;

  beforeAll(async () => {
    font = parseFont(new Uint8Array(await readFile(bundledFontPath)));
    fonts = new Map([[FAMILY, font]]);
    lineHeightAt = (size) => ((font.ascender - font.descender + font.lineGap) / font.unitsPerEm) * size;
    ascentAt = (size) => (font.ascender / font.unitsPerEm) * size;
  });

  it("沒傳 fonts 時維持既有行為：拋錯，訊息不變", () => {
    const model = parseSlide(
      slide('<g id="el-t"><text font-family="Noto Sans TC" font-size="40" x="0" y="0">哈囉</text></g>'),
    );
    expect(() => elementBounds(model.elements[0])).toThrow(
      "尚無法計算文字元素的邊界框：待 #76 的字型度量落地",
    );
  });

  it("純 <text>（沒有 tspan）：寬度是量出來的字串寬，高度是一行行高，y 是基線", () => {
    const model = parseSlide(
      slide('<g id="el-t"><text font-family="Noto Sans TC" font-size="40" x="100" y="300">哈囉</text></g>'),
    );
    const bounds = elementBounds(model.elements[0], { fonts });
    expect(bounds.width).toBeCloseTo(measureTextWidth(font, "哈囉", 40), 10);
    expect(bounds.height).toBeCloseTo(lineHeightAt(40), 10);
    expect(bounds.x).toBeCloseTo(100, 10);
    // <text y> 是第一行的基線，框頂在它上方 ascent 處。
    expect(bounds.y).toBeCloseTo(300 - ascentAt(40), 10);
  });

  it("文字框（有 data-comot-text-width 與 tspan）：寬度取宣告寬，高度是行數 × 行高，框頂在容器原點", () => {
    const model = parseSlide(
      slide(
        '<g id="el-box" data-comot-text-width="440" transform="translate(200 120)">' +
          '<text font-family="Noto Sans TC" font-size="40" xml:space="preserve">' +
          '<tspan x="0" y="36">文字框有寬度，文字寫滿</tspan>' +
          '<tspan x="0" y="94">就折到下一行。</tspan>' +
          "</text></g>",
      ),
    );
    const bounds = elementBounds(model.elements[0], { fonts });
    expect(bounds.x).toBeCloseTo(200, 10);
    expect(bounds.y).toBeCloseTo(120, 10);
    expect(bounds.width).toBeCloseTo(440, 10);
    expect(bounds.height).toBeCloseTo(2 * lineHeightAt(40), 10);
  });

  it("文字框帶 data-comot-text-height 時，高度直接取那個值，即使它與 tspan 行數 × 行高算出的不一致（NOOP-65 決定 C：烘進去的值是事實來源）", () => {
    const model = parseSlide(
      slide(
        '<g id="el-box" data-comot-text-width="440" data-comot-text-height="999" transform="translate(200 120)">' +
          '<text font-family="Noto Sans TC" font-size="40" xml:space="preserve">' +
          '<tspan x="0" y="36">文字框有寬度，文字寫滿</tspan>' +
          '<tspan x="0" y="94">就折到下一行。</tspan>' +
          "</text></g>",
      ),
    );
    const bounds = elementBounds(model.elements[0], { fonts });
    expect(bounds.height).toBe(999);
    expect(bounds.height).not.toBeCloseTo(2 * lineHeightAt(40), 10);
  });

  it("文字框沒有 data-comot-text-height 時（舊檔相容），高度退回行數 × 行高", () => {
    const model = parseSlide(
      slide(
        '<g id="el-box" data-comot-text-width="440" transform="translate(200 120)">' +
          '<text font-family="Noto Sans TC" font-size="40" xml:space="preserve">' +
          '<tspan x="0" y="36">A</tspan><tspan x="0" y="94">B</tspan><tspan x="0" y="152">C</tspan>' +
          "</text></g>",
      ),
    );
    const bounds = elementBounds(model.elements[0], { fonts });
    expect(bounds.height).toBeCloseTo(3 * lineHeightAt(40), 10);
  });

  it("空字串的 <text>：寬 0，高一行", () => {
    const model = parseSlide(
      slide('<g id="el-t"><text font-family="Noto Sans TC" font-size="40" x="10" y="50"></text></g>'),
    );
    const bounds = elementBounds(model.elements[0], { fonts });
    expect(bounds.width).toBe(0);
    expect(bounds.height).toBeCloseTo(lineHeightAt(40), 10);
  });

  it("祖先與容器的 transform 照樣套用在文字框上", () => {
    const model = parseSlide(
      slide(
        '<g id="el-box" data-comot-text-width="100" transform="translate(10 20)">' +
          '<text font-family="Noto Sans TC" font-size="20"><tspan x="0" y="18">A</tspan></text></g>',
      ),
    );
    const bounds = elementBounds(model.elements[0], { ancestors: [parseTransform("scale(2)")], fonts });
    expect(bounds.x).toBeCloseTo(20, 10);
    expect(bounds.y).toBeCloseTo(40, 10);
    expect(bounds.width).toBeCloseTo(200, 10);
    expect(bounds.height).toBeCloseTo(2 * lineHeightAt(20), 10);
  });

  it("傳了 fonts 但簡報沒有那個 family：照拋既有的錯，不退回預設字型", () => {
    const model = parseSlide(
      slide('<g id="el-t"><text font-family="Nonexistent Face" font-size="40" x="0" y="0">哈囉</text></g>'),
    );
    expect(() => elementBounds(model.elements[0], { fonts })).toThrow(CoMotionError);
    expect(() => elementBounds(model.elements[0], { fonts })).toThrow(/Nonexistent Face/);
  });

  it("<text> 缺 font-family 時報錯，不猜字型", () => {
    const model = parseSlide(slide('<g id="el-t"><text font-size="40" x="0" y="0">哈囉</text></g>'));
    expect(() => elementBounds(model.elements[0], { fonts })).toThrow(CoMotionError);
  });

  it("有 tspan 卻沒有 data-comot-text-width：報錯，不拿串接後的整串當一行量", () => {
    const model = parseSlide(
      slide(
        '<g id="el-t"><text font-family="Noto Sans TC" font-size="40">' +
          '<tspan x="0" y="36">一</tspan><tspan x="0" y="94">二</tspan></text></g>',
      ),
    );
    expect(() => elementBounds(model.elements[0], { fonts })).toThrow(CoMotionError);
  });
});
