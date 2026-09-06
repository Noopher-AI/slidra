import { describe, expect, it } from "vitest";
import { deriveSteps, validateEffectItem, SUPPORTED_EFFECTS } from "../src/effects/index.js";
import type { Effect, EffectFamily, EffectName, RawEffectAttributes } from "../src/effects/index.js";

/**
 * `validateEffectItem` (single source of truth for "is this effect item
 * legal", D1) and `deriveSteps` (moved here from `packages/web/src/effects.ts`
 * — see that file and `packages/web/test/effects.test.ts`'s pruned test
 * list, [E2.T7] plan §6.2). Public boundary under test: raw attribute
 * strings in, a typed `Effect` out, or a thrown `CoMotionError` — never an
 * internal call count.
 */

function raw(overrides: Partial<RawEffectAttributes> = {}): RawEffectAttributes {
  return {
    target: "el-a",
    family: "enter",
    effect: "fade",
    start: "on-click",
    duration: null,
    delay: null,
    d: null,
    ...overrides,
  };
}

function effect(target: string, start: Effect["start"]): Effect {
  return { target, family: "enter", effect: "fade", start, duration: 0.6, delay: 0, index: 0 };
}

describe("validateEffectItem: value sets (D4)", () => {
  it("接受 enter 家族全部五個效果名稱", () => {
    for (const name of SUPPORTED_EFFECTS.enter) {
      expect(validateEffectItem(raw({ family: "enter", effect: name }), 0, true).effect).toBe(name);
    }
  });

  it("接受 emphasis 家族全部三個效果名稱", () => {
    for (const name of SUPPORTED_EFFECTS.emphasis) {
      expect(validateEffectItem(raw({ family: "emphasis", effect: name }), 0, true).effect).toBe(name);
    }
  });

  it("接受 exit 家族全部三個效果名稱", () => {
    for (const name of SUPPORTED_EFFECTS.exit) {
      expect(validateEffectItem(raw({ family: "exit", effect: name }), 0, true).effect).toBe(name);
    }
  });

  it("接受 media 家族的 play 與 pause", () => {
    for (const name of SUPPORTED_EFFECTS.media) {
      expect(validateEffectItem(raw({ family: "media", effect: name }), 0, true).effect).toBe(name);
    }
  });

  it("接受 path 家族（effect 只有 path 一種），並保留 d", () => {
    const item = validateEffectItem(raw({ family: "path", effect: "path", d: "M 0 0 L 10 10" }), 0, true);
    expect(item.effect).toBe("path");
    expect(item.d).toBe("M 0 0 L 10 10");
  });

  it("start 三種全開", () => {
    for (const start of ["on-click", "with-previous", "after-previous"] as const) {
      expect(validateEffectItem(raw({ start }), 0, true).start).toBe(start);
    }
  });

  it("未實作的家族拋錯，訊息指出是第幾項、target 與該屬性值", () => {
    expect(() => validateEffectItem(raw({ family: "build" as EffectFamily }), 1, true)).toThrow(
      /第 2 項.*el-a.*family.*build/,
    );
  });

  it("未實作的效果拋錯", () => {
    expect(() => validateEffectItem(raw({ effect: "fly-in" as EffectName }), 0, true)).toThrow(
      /第 1 項.*el-a.*effect.*fly-in/,
    );
  });

  it("未實作的起始方式拋錯", () => {
    expect(() => validateEffectItem(raw({ start: "on-hover" as Effect["start"] }), 0, true)).toThrow(
      /第 1 項.*el-a.*start.*on-hover/,
    );
  });

  it("effect 不屬於該 family 的清單時拋錯（例如 enter 家族用 pulse）", () => {
    expect(() => validateEffectItem(raw({ family: "enter", effect: "pulse" as EffectName }), 0, true)).toThrow(
      /effect.*pulse/,
    );
  });

  it("缺少必要屬性拋錯", () => {
    expect(() => validateEffectItem(raw({ target: null }), 0, true)).toThrow(/第 1 項.*target/);
  });

  it("target 存在但為空字串時視為缺席", () => {
    expect(() => validateEffectItem(raw({ target: "" }), 0, true)).toThrow(/缺少必要屬性 target/);
  });

  it("target 指向不存在的元素時拋錯，不略過該項", () => {
    expect(() => validateEffectItem(raw(), 1, false)).toThrow(/第 2 項.*el-a.*指向的元素不存在.*簡報已損毀/);
  });

  it("錯誤訊息是繁體中文，且不含檔案系統路徑", () => {
    let message = "";
    try {
      validateEffectItem(raw({ family: "build" as EffectFamily }), 0, true);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/[一-鿿]/);
    expect(message).not.toMatch(/\//);
  });
});

describe("validateEffectItem: duration/delay (D3)", () => {
  it("duration 屬性缺席時依家族取預設值：media 為 0，其餘為 0.6", () => {
    expect(validateEffectItem(raw(), 0, true).duration).toBe(0.6);
    expect(validateEffectItem(raw({ family: "media", effect: "play" }), 0, true).duration).toBe(0);
  });

  it("delay 屬性缺席時預設為 0", () => {
    expect(validateEffectItem(raw(), 0, true).delay).toBe(0);
  });

  it("duration 恰為 0 合法（瞬間效果）", () => {
    expect(validateEffectItem(raw({ duration: "0" }), 0, true).duration).toBe(0);
  });

  it.each(["abc", "", "1,5", "NaN", "Infinity"])("duration 值「%s」不是合法的秒數，拋錯且不回傳修補值", (bad) => {
    expect(() => validateEffectItem(raw({ duration: bad }), 0, true)).toThrow(/duration 值.*不是合法的秒數/);
  });

  it("duration 為負數時拋錯", () => {
    expect(() => validateEffectItem(raw({ duration: "-1" }), 0, true)).toThrow(/duration 值.*不是合法的秒數/);
  });

  it("delay 為負數時拋錯", () => {
    expect(() => validateEffectItem(raw({ delay: "-0.5" }), 0, true)).toThrow(/delay 值.*不是合法的秒數/);
  });
});

describe("validateEffectItem: d / path (D4)", () => {
  it("family 是 path 但缺少 d 時拋錯", () => {
    expect(() => validateEffectItem(raw({ family: "path", effect: "path" }), 0, true)).toThrow(
      /family 是 path，但沒有 d，簡報已損毀/,
    );
  });

  it("d 存在但 family 不是 path 時合法，原樣保留", () => {
    const item = validateEffectItem(raw({ d: "M 0 0" }), 0, true);
    expect(item.d).toBe("M 0 0");
    expect(item.family).toBe("enter");
  });

  it("d 缺席且 family 不是 path 時合法（忽略）", () => {
    expect(validateEffectItem(raw(), 0, true).d).toBeUndefined();
  });
});

describe("deriveSteps", () => {
  it("空清單推導出零步", () => {
    expect(deriveSteps([])).toEqual([]);
  });

  it("每個 on-click 開啟一個新步驟，步驟順序等同清單順序", () => {
    const effects = [effect("a", "on-click"), effect("b", "on-click")];
    expect(deriveSteps(effects)).toEqual([{ effects: [effects[0]] }, { effects: [effects[1]] }]);
  });

  it("with-previous 與 after-previous 併入當前步驟", () => {
    const effects = [
      effect("a", "on-click"),
      effect("b", "with-previous"),
      effect("c", "after-previous"),
      effect("d", "on-click"),
    ];
    expect(deriveSteps(effects)).toEqual([
      { effects: [effects[0], effects[1], effects[2]] },
      { effects: [effects[3]] },
    ]);
  });

  it("第一項不是 on-click 時拋錯", () => {
    expect(() => deriveSteps([effect("a", "with-previous")])).toThrow(/第 1 項/);
  });
});
