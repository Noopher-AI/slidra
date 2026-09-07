import { describe, expect, it } from "vitest";
import { CoMotionError, CoMotionNotFoundError } from "../src/errors.js";
import { addEffects, moveEffect, readEffectList, removeEffects, removeEffectsTargeting, setEffect } from "../src/effects/edit.js";
import { groupElements, ungroupElements } from "../src/element-group.js";
import { setSlideNotes } from "../src/notes.js";

/**
 * `packages/core/src/effects/edit.ts` — the splice-only writer for
 * `<comot:effects>` (this ticket's first-ever writer for the list; before
 * this it was only ever read, or opaquely swept along by
 * `element-clipboard.ts`/`element-edit.ts`'s tag-literal cleanup). Public
 * boundary under test: `svgContent: string -> svgContent: string`,
 * asserted on the resulting bytes — never on which internal helper ran.
 */

const SLIDE_PATH = "slides/001.svg";
const NS = "https://co-motion.dev/ns";

function slide(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${inner}</svg>`;
}

const TWO_ELEMENTS = '<g id="el-a"><rect x="0" y="0" width="10" height="10"/></g><g id="el-b"><rect x="0" y="0" width="10" height="10"/></g>';

function effectAttrs(svg: string, index: number): Record<string, string> {
  const list = readEffectList(svg, SLIDE_PATH);
  const item = list[index];
  return { family: item.family, effect: item.effect, start: item.start, duration: String(item.duration), delay: String(item.delay) };
}

describe("addEffects", () => {
  it("在完全沒有 <metadata> 的投影片上新增，建立 <metadata><comot:effects>", () => {
    const svg = slide(TWO_ELEMENTS);
    const updated = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
    expect(updated).toContain(`<comot:effects xmlns:comot="${NS}">`);
    const list = readEffectList(updated, SLIDE_PATH);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ target: "el-a", family: "enter", effect: "fade", start: "on-click", duration: 0.6, delay: 0 });
  });

  it("在有 <metadata> 但沒有 <comot:effects> 的投影片上新增，不動既有的 <comot:notes>", () => {
    const withNotes = setSlideNotes(slide(TWO_ELEMENTS), "speaker notes");
    const updated = addEffects(withNotes, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
    expect(updated).toContain("<comot:notes");
    expect(updated).toContain("speaker notes");
    expect(readEffectList(updated, SLIDE_PATH)).toHaveLength(1);
  });

  it("預設插入在清單末端，維持既有項目順序", () => {
    let svg = slide(TWO_ELEMENTS);
    svg = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
    svg = addEffects(svg, SLIDE_PATH, ["el-b"], { family: "enter", effect: "zoom" });
    const list = readEffectList(svg, SLIDE_PATH);
    expect(list.map((item) => item.target)).toEqual(["el-a", "el-b"]);
  });

  it("--index 指定插入位置", () => {
    let svg = slide(TWO_ELEMENTS);
    svg = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
    svg = addEffects(svg, SLIDE_PATH, ["el-b"], { family: "enter", effect: "zoom", index: 1 });
    const list = readEffectList(svg, SLIDE_PATH);
    expect(list.map((item) => item.target)).toEqual(["el-b", "el-a"]);
  });

  it("--index 超出範圍時拋錯，不寫入", () => {
    const svg = slide(TWO_ELEMENTS);
    expect(() => addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade", index: 0 })).toThrow(/--index 超出範圍/);
    expect(() => addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade", index: 2 })).toThrow(/--index 超出範圍/);
  });

  it("多個 element-id：第一筆帶給定的 start，其餘一律 with-previous", () => {
    const svg = slide(TWO_ELEMENTS);
    const updated = addEffects(svg, SLIDE_PATH, ["el-a", "el-b"], { family: "enter", effect: "fade", start: "after-previous" });
    const list = readEffectList(updated, SLIDE_PATH);
    expect(list.map((item) => item.start)).toEqual(["after-previous", "with-previous"]);
  });

  it("element-id 不存在時拋 CoMotionNotFoundError，一個位元組都不寫", () => {
    const svg = slide(TWO_ELEMENTS);
    expect(() => addEffects(svg, SLIDE_PATH, ["el-a", "el-nope"], { family: "enter", effect: "fade" })).toThrow(CoMotionNotFoundError);
    // Nothing committed for the valid id either — all-or-nothing.
    expect(() => readEffectList(svg, SLIDE_PATH)).toThrow(CoMotionNotFoundError);
  });

  it("family=path 沒給 d 時拋錯，不寫入", () => {
    const svg = slide(TWO_ELEMENTS);
    expect(() => addEffects(svg, SLIDE_PATH, ["el-a"], { family: "path", effect: "path" })).toThrow(/沒有給 d/);
  });

  it("family=path 給了 d 時寫入成功", () => {
    const svg = slide(TWO_ELEMENTS);
    const updated = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "path", effect: "path", d: "M 0 0 L 100 100" });
    expect(readEffectList(updated, SLIDE_PATH)[0].d).toBe("M 0 0 L 100 100");
  });

  it("duration/delay 沒給值時依家族寫入預設值（一律寫齊，D3）", () => {
    const svg = slide(TWO_ELEMENTS);
    const updated = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "media", effect: "play" });
    expect(updated).toMatch(/duration="0"/);
    expect(updated).toMatch(/delay="0"/);
  });

  it("duration 為負數時拋錯", () => {
    const svg = slide(TWO_ELEMENTS);
    expect(() => addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade", duration: -1 })).toThrow(CoMotionError);
  });

  it("既有 <comot:effects> 的 xmlns:comot 值不對時，新增操作順便改寫成正確值", () => {
    const broken = slide(
      `<metadata><comot:effects xmlns:comot="https://schemas.comotion.app/effects">` +
        `<comot:effect target="el-a" family="enter" effect="fade" start="on-click" duration="0.6" delay="0"/>` +
        `</comot:effects></metadata>${TWO_ELEMENTS}`,
    );
    const updated = addEffects(broken, SLIDE_PATH, ["el-b"], { family: "enter", effect: "zoom" });
    expect(updated).toContain(`xmlns:comot="${NS}"`);
    expect(updated).not.toContain("schemas.comotion.app");
    expect(readEffectList(updated, SLIDE_PATH)).toHaveLength(2);
  });
});

describe("readEffectList / effect list", () => {
  it("投影片沒有 <comot:effects> 時拋 CoMotionNotFoundError（與 parseEffects 的『合法空清單』不同，4.3）", () => {
    expect(() => readEffectList(slide(TWO_ELEMENTS), SLIDE_PATH)).toThrow(CoMotionNotFoundError);
  });
});

describe("removeEffects", () => {
  function twoEffectSlide(): string {
    let svg = slide(TWO_ELEMENTS);
    svg = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
    svg = addEffects(svg, SLIDE_PATH, ["el-b"], { family: "enter", effect: "zoom" });
    return svg;
  }

  it("移除單一效果項", () => {
    const updated = removeEffects(twoEffectSlide(), SLIDE_PATH, [1]);
    const list = readEffectList(updated, SLIDE_PATH);
    expect(list).toHaveLength(1);
    expect(list[0].target).toBe("el-b");
  });

  it("一次移除多個效果項，由大到小刪以免位移", () => {
    let svg = twoEffectSlide();
    svg = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "emphasis", effect: "pulse" });
    const updated = removeEffects(svg, SLIDE_PATH, [1, 3]);
    const list = readEffectList(updated, SLIDE_PATH);
    expect(list.map((item) => item.effect)).toEqual(["zoom"]);
  });

  it("index 超出範圍時，先驗證再動手，不寫入", () => {
    const svg = twoEffectSlide();
    expect(() => removeEffects(svg, SLIDE_PATH, [1, 99])).toThrow(/超出範圍/);
    expect(readEffectList(svg, SLIDE_PATH)).toHaveLength(2);
  });
});

describe("moveEffect", () => {
  function threeEffectSlide(): string {
    const withElements = slide(
      '<g id="el-a"><rect x="0" y="0" width="1" height="1"/></g>' +
        '<g id="el-b"><rect x="0" y="0" width="1" height="1"/></g>' +
        '<g id="el-c"><rect x="0" y="0" width="1" height="1"/></g>',
    );
    let svg = addEffects(withElements, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
    svg = addEffects(svg, SLIDE_PATH, ["el-b"], { family: "enter", effect: "zoom" });
    svg = addEffects(svg, SLIDE_PATH, ["el-c"], { family: "enter", effect: "appear" });
    return svg;
  }

  it("up 把項目往前移一位", () => {
    const updated = moveEffect(threeEffectSlide(), SLIDE_PATH, 2, "up");
    expect(readEffectList(updated, SLIDE_PATH).map((item) => item.target)).toEqual(["el-b", "el-a", "el-c"]);
  });

  it("down 把項目往後移一位", () => {
    const updated = moveEffect(threeEffectSlide(), SLIDE_PATH, 2, "down");
    expect(readEffectList(updated, SLIDE_PATH).map((item) => item.target)).toEqual(["el-a", "el-c", "el-b"]);
  });

  it("已經是第一項時 up 是 no-op，回 ok 不拋錯", () => {
    const svg = threeEffectSlide();
    const updated = moveEffect(svg, SLIDE_PATH, 1, "up");
    expect(updated).toBe(svg);
  });

  it("已經是最後一項時 down 是 no-op，回 ok 不拋錯", () => {
    const svg = threeEffectSlide();
    const updated = moveEffect(svg, SLIDE_PATH, 3, "down");
    expect(updated).toBe(svg);
  });
});

describe("setEffect", () => {
  function oneEffectSlide(): string {
    return addEffects(slide(TWO_ELEMENTS), SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
  }

  it("一個 flag 都不給時拋錯", () => {
    expect(() => setEffect(oneEffectSlide(), SLIDE_PATH, 1, {})).toThrow(/至少要指定一個要改的欄位/);
  });

  it("改 effect（同 family 內）、start、duration、delay 立即生效", () => {
    const updated = setEffect(oneEffectSlide(), SLIDE_PATH, 1, { effect: "zoom", start: "with-previous", duration: 1.2, delay: 0.3 });
    expect(effectAttrs(updated, 0)).toEqual({ family: "enter", effect: "zoom", start: "with-previous", duration: "1.2", delay: "0.3" });
  });

  it("effect 值不屬於該項的 family 時拋錯（family 不能用 set 改）", () => {
    expect(() => setEffect(oneEffectSlide(), SLIDE_PATH, 1, { effect: "pulse" })).toThrow(/family 無法用 set 變更/);
  });

  it("d 用在非 path 項時拋錯", () => {
    expect(() => setEffect(oneEffectSlide(), SLIDE_PATH, 1, { d: "M 0 0" })).toThrow(/只有 family="path" 的效果項可以設定 d/);
  });

  it("d 用在 path 項時合法", () => {
    const svg = addEffects(slide(TWO_ELEMENTS), SLIDE_PATH, ["el-a"], { family: "path", effect: "path", d: "M 0 0" });
    const updated = setEffect(svg, SLIDE_PATH, 1, { d: "M 10 10 L 20 20" });
    expect(readEffectList(updated, SLIDE_PATH)[0].d).toBe("M 10 10 L 20 20");
  });

  it("index 超出範圍時拋錯", () => {
    expect(() => setEffect(oneEffectSlide(), SLIDE_PATH, 5, { duration: 1 })).toThrow(/超出範圍/);
  });
});

describe("element group / ungroup 清除效果項 ([E2.T7])", () => {
  it("element group 移除每個成員自身的效果項，並回報移除數量", () => {
    let svg = slide(TWO_ELEMENTS);
    svg = addEffects(svg, SLIDE_PATH, ["el-a"], { family: "enter", effect: "fade" });
    svg = addEffects(svg, SLIDE_PATH, ["el-b"], { family: "enter", effect: "zoom" });

    const result = groupElements(svg, SLIDE_PATH, ["el-a", "el-b"], "el-group");
    expect(result.removedEffects).toBe(2);
    expect(readEffectList(result.svg, SLIDE_PATH)).toHaveLength(0);
  });

  it("element group 對沒有動畫的成員不受影響（removedEffects: 0）", () => {
    const svg = slide(TWO_ELEMENTS);
    const result = groupElements(svg, SLIDE_PATH, ["el-a", "el-b"], "el-group");
    expect(result.removedEffects).toBe(0);
  });

  it("element ungroup 移除 target 指向該群組的效果項", () => {
    let svg = slide(TWO_ELEMENTS);
    const grouped = groupElements(svg, SLIDE_PATH, ["el-a", "el-b"], "el-group");
    svg = addEffects(grouped.svg, SLIDE_PATH, ["el-group"], { family: "enter", effect: "fade" });
    expect(readEffectList(svg, SLIDE_PATH)).toHaveLength(1);

    const ungrouped = ungroupElements(svg, SLIDE_PATH, ["el-group"]);
    expect(readEffectList(ungrouped.svg, SLIDE_PATH)).toHaveLength(0);
    expect(ungrouped.removedEffects).toBe(1);
  });
});

describe("removeEffectsTargeting", () => {
  it("投影片完全沒有效果清單時是合法的 no-op", () => {
    const svg = slide(TWO_ELEMENTS);
    const result = removeEffectsTargeting(svg, SLIDE_PATH, new Set(["el-a"]));
    expect(result).toEqual({ updated: svg, removedCount: 0 });
  });
});
