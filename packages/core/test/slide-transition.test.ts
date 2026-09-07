import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { readSlideTransition, setSlideTransition, slideHasTransitionMetadata } from "../src/slide/transition.js";

/**
 * [E2.T11]: the `<comot:transition>` splice model — `readSlideTransition`'s
 * §4.2 behaviour contract, and `setSlideTransition`'s create/update/
 * namespace-fix/byte-preservation, modeled directly on
 * `slide-comments.test.ts`'s style for the same kind of splice-only writer.
 * Expectations are either hand-written literal strings or the exact input a
 * splice must leave untouched — never the function's own output re-asserted
 * back at itself.
 */

function slide(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${inner}</svg>`;
}

const NS = `xmlns:comot="https://co-motion.dev/ns"`;

describe("readSlideTransition", () => {
  it("沒有 <metadata> 時回傳預設值（enter/exit 皆 none）", () => {
    expect(readSlideTransition(slide('<g id="el-a"><rect/></g>'))).toEqual({
      enter: { effect: "none", duration: 0.6 },
      exit: { effect: "none", duration: 0.5 },
    });
  });

  it("<metadata> 存在但沒有 <comot:transition> 時回傳預設值", () => {
    expect(readSlideTransition(slide("<metadata><comot:notes>hi</comot:notes></metadata>"))).toEqual({
      enter: { effect: "none", duration: 0.6 },
      exit: { effect: "none", duration: 0.5 },
    });
  });

  it("四個屬性齊全時逐一讀出", () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter="fade" enter-duration="0.8" exit="zoom" exit-duration="1.2"/></metadata>`);
    expect(readSlideTransition(svg)).toEqual({
      enter: { effect: "fade", duration: 0.8 },
      exit: { effect: "zoom", duration: 1.2 },
    });
  });

  it("缺 enter 屬性：該欄位取預設 none，其餘照讀", () => {
    const svg = slide(`<metadata><comot:transition ${NS} exit="slide" exit-duration="0.3"/></metadata>`);
    expect(readSlideTransition(svg)).toEqual({
      enter: { effect: "none", duration: 0.6 },
      exit: { effect: "slide", duration: 0.3 },
    });
  });

  it('enter=""（存在但為空）明確拋錯', () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter=""/></metadata>`);
    expect(() => readSlideTransition(svg)).toThrow(CoMotionError);
    expect(() => readSlideTransition(svg)).toThrow('頁面進出場的 enter 值「」尚未實作。');
  });

  it('enter="wipe"（不在值集合）明確拋錯', () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter="wipe"/></metadata>`);
    expect(() => readSlideTransition(svg)).toThrow('頁面進出場的 enter 值「wipe」尚未實作。');
  });

  it('exit="spin"（不在值集合）明確拋錯', () => {
    const svg = slide(`<metadata><comot:transition ${NS} exit="spin"/></metadata>`);
    expect(() => readSlideTransition(svg)).toThrow('頁面進出場的 exit 值「spin」尚未實作。');
  });

  it('enter-duration="abc" 明確拋錯', () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter-duration="abc"/></metadata>`);
    expect(() => readSlideTransition(svg)).toThrow('頁面進出場的 enter-duration 值「abc」不是合法的秒數。');
  });

  it('enter-duration="-1" 明確拋錯', () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter-duration="-1"/></metadata>`);
    expect(() => readSlideTransition(svg)).toThrow('頁面進出場的 enter-duration 值「-1」不是合法的秒數。');
  });

  it('enter-duration="0" 合法（瞬切，不是錯誤）', () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter-duration="0"/></metadata>`);
    expect(readSlideTransition(svg).enter.duration).toBe(0);
  });

  it('enter-duration="3"（超出 GUI 滑桿 0.2–1.5）合法，讀回真值', () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter-duration="3"/></metadata>`);
    expect(readSlideTransition(svg).enter.duration).toBe(3);
  });

  it("同一個 <metadata> 裡兩個 <comot:transition>：明確拋錯，指出份數", () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter="fade"/><comot:transition ${NS} enter="zoom"/></metadata>`);
    expect(() => readSlideTransition(svg)).toThrow(
      "這張投影片的 metadata 裡有 2 組頁面進出場設定，但一張投影片只能有一份，簡報已損毀。",
    );
  });

  it("整份 markup 不是合法投影片：沿用 scanDocument 拋出的錯，不自己包裝成空值", () => {
    expect(() => readSlideTransition('<g id="el-a"><rect/></g>')).toThrow(CoMotionError);
  });
});

describe("slideHasTransitionMetadata", () => {
  it("沒有 <comot:transition> 時回傳 false", () => {
    expect(slideHasTransitionMetadata(slide('<g id="el-a"><rect/></g>'))).toBe(false);
  });

  it("有 <comot:transition> 時回傳 true", () => {
    expect(slideHasTransitionMetadata(slide(`<metadata><comot:transition ${NS} enter="fade"/></metadata>`))).toBe(true);
  });
});

describe("setSlideTransition", () => {
  const transition = {
    enter: { effect: "fade" as const, duration: 0.8 },
    exit: { effect: "zoom" as const, duration: 1.2 },
  };

  it("沒有 <metadata> 時建立並寫入 <comot:transition>", () => {
    const svg = slide('<g id="el-a"><rect/></g>');
    const updated = setSlideTransition(svg, transition);
    expect(updated).toBe(
      slide(`<metadata><comot:transition ${NS} enter="fade" enter-duration="0.8" exit="zoom" exit-duration="1.2"/></metadata><g id="el-a"><rect/></g>`),
    );
  });

  it("有 <metadata> 但沒有 <comot:transition> 時插入，既有內容不動", () => {
    const svg = slide("<metadata><comot:notes>備忘稿</comot:notes></metadata>");
    const updated = setSlideTransition(svg, transition);
    expect(updated).toBe(
      slide(
        `<metadata><comot:transition ${NS} enter="fade" enter-duration="0.8" exit="zoom" exit-duration="1.2"/><comot:notes>備忘稿</comot:notes></metadata>`,
      ),
    );
  });

  it("已有 <comot:transition> 時整個取代（四個屬性一律重寫齊全）", () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter="none" enter-duration="0.6" exit="none" exit-duration="0.5"/></metadata>`);
    const updated = setSlideTransition(svg, { enter: { effect: "slide", duration: 0.4 }, exit: { effect: "none", duration: 0 } });
    expect(updated).toBe(
      slide(`<metadata><comot:transition ${NS} enter="slide" enter-duration="0.4" exit="none" exit-duration="0"/></metadata>`),
    );
  });

  it("部分更新時仍然逐一寫齊四個屬性——呼叫端負責把未變動的欄位一併帶入", () => {
    const svg = slide(`<metadata><comot:transition ${NS} enter="fade" enter-duration="0.6" exit="none" exit-duration="0.5"/></metadata>`);
    const current = readSlideTransition(svg);
    const updated = setSlideTransition(svg, { ...current, enter: { effect: "none", duration: current.enter.duration } });
    expect(readSlideTransition(updated)).toEqual({
      enter: { effect: "none", duration: 0.6 },
      exit: { effect: "none", duration: 0.5 },
    });
  });

  it("既有 <comot:transition> 缺 xmlns:comot（手動寫入的舊檔）：重寫後補上正確命名空間", () => {
    const svg = slide('<metadata><comot:transition enter="fade" enter-duration="0.6" exit="none" exit-duration="0.5"/></metadata>');
    const updated = setSlideTransition(svg, { enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } });
    expect(updated).toBe(
      slide(`<metadata><comot:transition ${NS} enter="none" enter-duration="0.6" exit="none" exit-duration="0.5"/></metadata>`),
    );
  });

  it("既有 <comot:effects> 與 <comot:notes> 不受影響，位元組原封不動", () => {
    const effectsBlock = `<comot:effects ${NS}><comot:effect target="el-a" family="enter" effect="fade" start="on-click"/></comot:effects>`;
    const notesBlock = "<comot:notes>備忘稿</comot:notes>";
    const svg = slide(`<metadata>${effectsBlock}${notesBlock}</metadata>`);
    const updated = setSlideTransition(svg, transition);
    expect(updated).toContain(effectsBlock);
    expect(updated).toContain(notesBlock);
    expect(updated).toContain(`enter="fade" enter-duration="0.8" exit="zoom" exit-duration="1.2"`);
  });

  it("duration 用 formatSvgNumber 序列化——整數不留多餘小數", () => {
    const svg = slide('<g id="el-a"/>');
    const updated = setSlideTransition(svg, { enter: { effect: "fade", duration: 1 }, exit: { effect: "none", duration: 0 } });
    expect(updated).toContain('enter-duration="1"');
    expect(updated).toContain('exit-duration="0"');
  });
});
