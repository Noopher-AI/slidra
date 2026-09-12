import { describe, expect, it } from "vitest";
import { INITIAL_PASTE_OFFSET_STATE, PASTE_OFFSET_STEP, clipboardWritten, nextPasteOffset } from "../src/paste-offset.js";

describe("nextPasteOffset", () => {
  it("dx/dy are 0 when pasting onto a different slide (neither the source page nor the last pasted-onto page)", () => {
    const state = clipboardWritten("slides/a.svg");
    const { dx, dy } = nextPasteOffset(state, "slides/b.svg");
    expect(dx).toBe(0);
    expect(dy).toBe(0);
  });

  it("pasting back onto the source page has an offset from the very first paste, so the new element isn't stacked exactly on the original", () => {
    const state = clipboardWritten("slides/a.svg");
    const { dx, dy } = nextPasteOffset(state, "slides/a.svg");
    expect(dx).toBe(PASTE_OFFSET_STEP);
    expect(dy).toBe(PASTE_OFFSET_STEP);
  });

  it("pasting onto the same page three times in a row increases the offset monotonically by one fixed step each time (covers the case of staggering two copies apart)", () => {
    let state = clipboardWritten("slides/a.svg");
    const offsets: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = nextPasteOffset(state, "slides/a.svg");
      offsets.push(result.dx);
      state = result.next;
    }
    expect(offsets).toEqual([PASTE_OFFSET_STEP, PASTE_OFFSET_STEP * 2, PASTE_OFFSET_STEP * 3]);
  });

  it("switching to another page and pasting resets the offset count to zero", () => {
    let state = clipboardWritten("slides/a.svg");
    state = nextPasteOffset(state, "slides/a.svg").next;
    state = nextPasteOffset(state, "slides/a.svg").next;
    const onB = nextPasteOffset(state, "slides/b.svg");
    expect(onB.dx).toBe(0);
  });

  it("A→B→A: returning to the source page recalculates, without continuing B's count", () => {
    let state = clipboardWritten("slides/a.svg");
    state = nextPasteOffset(state, "slides/a.svg").next; // paste #1 on A: dx=20
    state = nextPasteOffset(state, "slides/b.svg").next; // paste on B: dx=0
    const backOnA = nextPasteOffset(state, "slides/a.svg");
    expect(backOnA.dx).toBe(PASTE_OFFSET_STEP);
  });

  it("dx and dy are always equal", () => {
    let state = clipboardWritten("slides/a.svg");
    for (let i = 0; i < 4; i++) {
      const result = nextPasteOffset(state, i % 2 === 0 ? "slides/a.svg" : "slides/b.svg");
      expect(result.dx).toBe(result.dy);
      state = result.next;
    }
  });
});

describe("clipboardWritten", () => {
  it("resets the offset count and the last paste target, and records the new source page", () => {
    let state = clipboardWritten("slides/a.svg");
    state = nextPasteOffset(state, "slides/a.svg").next;
    state = nextPasteOffset(state, "slides/a.svg").next;

    const recopied = clipboardWritten("slides/c.svg");
    expect(recopied).toEqual({ sourceSlidePath: "slides/c.svg", lastTargetSlidePath: null, count: 0 });
  });
});

describe("INITIAL_PASTE_OFFSET_STATE", () => {
  it("pasting onto any page in the initial state has no offset (nothing has been copied yet)", () => {
    const { dx, dy } = nextPasteOffset(INITIAL_PASTE_OFFSET_STATE, "slides/a.svg");
    expect(dx).toBe(0);
    expect(dy).toBe(0);
  });
});
