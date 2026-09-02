import { describe, expect, it } from "vitest";
import {
  INITIAL_PASTE_OFFSET_STATE,
  PASTE_OFFSET_STEP,
  clipboardWritten,
  nextPasteOffset,
  type PasteOffsetState,
} from "../src/paste-offset.js";

describe("nextPasteOffset", () => {
  it("跨投影片貼上（目標不是來源頁也不是上次貼上的頁）時 dx/dy 為 0（A4）", () => {
    const state = clipboardWritten("slides/a.svg");
    const { dx, dy } = nextPasteOffset(state, "slides/b.svg");
    expect(dx).toBe(0);
    expect(dy).toBe(0);
  });

  it("貼回來源頁時第一次就有偏移，避免新元素完全疊在原件上", () => {
    const state = clipboardWritten("slides/a.svg");
    const { dx, dy } = nextPasteOffset(state, "slides/a.svg");
    expect(dx).toBe(PASTE_OFFSET_STEP);
    expect(dy).toBe(PASTE_OFFSET_STEP);
  });

  it("同頁連續貼上，偏移逐次遞增，兩份彼此錯開（A3）", () => {
    let state = clipboardWritten("slides/a.svg");
    const first = nextPasteOffset(state, "slides/a.svg");
    state = first.next;
    const second = nextPasteOffset(state, "slides/a.svg");
    expect(second.dx).toBeGreaterThan(first.dx);
    expect(second.dx).toBe(first.dx + PASTE_OFFSET_STEP);
  });

  it("同頁連續貼上三次，偏移單調遞增且每次固定加一步", () => {
    let state = clipboardWritten("slides/a.svg");
    const offsets: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = nextPasteOffset(state, "slides/a.svg");
      offsets.push(result.dx);
      state = result.next;
    }
    expect(offsets).toEqual([PASTE_OFFSET_STEP, PASTE_OFFSET_STEP * 2, PASTE_OFFSET_STEP * 3]);
  });

  it("換到另一頁再貼上，偏移計數歸零", () => {
    let state = clipboardWritten("slides/a.svg");
    state = nextPasteOffset(state, "slides/a.svg").next;
    state = nextPasteOffset(state, "slides/a.svg").next;
    const onB = nextPasteOffset(state, "slides/b.svg");
    expect(onB.dx).toBe(0);
  });

  it("A→B→A：回到來源頁時重新計算，不延續 B 上的計數", () => {
    let state = clipboardWritten("slides/a.svg");
    state = nextPasteOffset(state, "slides/a.svg").next; // paste #1 on A: dx=20
    state = nextPasteOffset(state, "slides/b.svg").next; // paste on B: dx=0
    const backOnA = nextPasteOffset(state, "slides/a.svg");
    expect(backOnA.dx).toBe(PASTE_OFFSET_STEP);
  });

  it("來源頁未知（null）時視為非來源頁，第一次貼上 dx/dy 為 0", () => {
    const state: PasteOffsetState = { sourceSlidePath: null, lastTargetSlidePath: null, count: 0 };
    const { dx, dy } = nextPasteOffset(state, "slides/a.svg");
    expect(dx).toBe(0);
    expect(dy).toBe(0);
  });

  it("dx 與 dy 恆相等", () => {
    let state = clipboardWritten("slides/a.svg");
    for (let i = 0; i < 4; i++) {
      const result = nextPasteOffset(state, i % 2 === 0 ? "slides/a.svg" : "slides/b.svg");
      expect(result.dx).toBe(result.dy);
      state = result.next;
    }
  });
});

describe("clipboardWritten", () => {
  it("重設偏移計數與上次貼上目標，記下新的來源頁", () => {
    let state = clipboardWritten("slides/a.svg");
    state = nextPasteOffset(state, "slides/a.svg").next;
    state = nextPasteOffset(state, "slides/a.svg").next;

    const recopied = clipboardWritten("slides/c.svg");
    expect(recopied).toEqual({ sourceSlidePath: "slides/c.svg", lastTargetSlidePath: null, count: 0 });
  });
});

describe("INITIAL_PASTE_OFFSET_STATE", () => {
  it("初始狀態下貼上任何頁都不偏移（尚未複製過任何東西）", () => {
    const { dx, dy } = nextPasteOffset(INITIAL_PASTE_OFFSET_STATE, "slides/a.svg");
    expect(dx).toBe(0);
    expect(dy).toBe(0);
  });
});
