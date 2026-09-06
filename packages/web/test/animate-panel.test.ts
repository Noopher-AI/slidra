import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Effect } from "../src/effects.js";
import { buildCards, cardLabel, EffectCard, type EffectCardData } from "../src/shell/side/animate/cards.js";
import { ObjectList } from "../src/shell/side/animate/ObjectList.js";
import { Timeline } from "../src/shell/side/animate/Timeline.js";
import type { TargetInfo } from "../src/shell/side/animate/useSlideEffects.js";

/**
 * [E2.T7]/NOOP-66/#206 §6.4: the panel/timeline's public boundary is
 * `renderToStaticMarkup` output (same convention `stage-overlays.test.ts`
 * already uses) — never an internal call count or React fibre inspection.
 */

function effect(overrides: Partial<Effect> = {}): Effect {
  return { target: "el-a", family: "enter", effect: "fade", start: "on-click", duration: 0.6, delay: 0, index: 0, ...overrides };
}

function noop(): void {
  /* renderToStaticMarkup never fires handlers — these exist only to satisfy prop types. */
}

describe("buildCards / cardLabel", () => {
  it("一般元素：沒有 targetInfo 時退回顯示 target id", () => {
    const cards = buildCards([effect()], new Map());
    expect(cardLabel(cards[0], 1)).toBe("el-a");
  });

  it("一般元素：targetInfo 有 data-comot-name 時顯示名稱", () => {
    const info = new Map<string, TargetInfo>([["el-a", { name: "標題", groupMemberCount: null }]]);
    const cards = buildCards([effect()], info);
    expect(cardLabel(cards[0], 1)).toBe("標題");
  });

  it("D5：target 是群組時顯示「Group N (n)」，n 是成員數，不是名稱", () => {
    const info = new Map<string, TargetInfo>([["el-group", { name: "群組", groupMemberCount: 3 }]]);
    const cards = buildCards([effect({ target: "el-group" })], info);
    expect(cardLabel(cards[0], 2)).toBe("Group 2 (3)");
  });

  it("index 貫穿到卡片資料上，供 CLI/preview 定址使用", () => {
    const cards = buildCards([effect({ index: 0 }), effect({ target: "el-b", index: 1 })], new Map());
    expect(cards.map((c) => c.index)).toEqual([0, 1]);
  });
});

describe("ObjectList", () => {
  const handlers = {
    onChangeEffect: noop,
    onChangeStart: noop,
    onChangeDuration: noop,
    onChangeDelay: noop,
    onMove: noop,
    onRemove: noop,
    onPreview: noop,
  };

  it("空清單顯示原型的空態文案，一字不改", () => {
    const markup = renderToStaticMarkup(createElement(ObjectList, { cards: [], ...handlers }));
    expect(markup).toContain("No animations on this slide.");
  });

  it("每個效果一張卡，編號依清單順序（1-based）", () => {
    const cards: EffectCardData[] = buildCards(
      [effect({ index: 0 }), effect({ target: "el-b", effect: "zoom", index: 1 })],
      new Map(),
    );
    const markup = renderToStaticMarkup(createElement(ObjectList, { cards, ...handlers }));
    const numbers = [...markup.matchAll(/animate-card-number[^>]*>(\d+)</g)].map((m) => m[1]);
    expect(numbers).toEqual(["1", "2"]);
    expect(markup).toContain("el-a");
    expect(markup).toContain("el-b");
  });

  it("第一張卡的上移按鈕停用，最後一張卡的下移按鈕停用", () => {
    const cards = buildCards([effect({ index: 0 }), effect({ target: "el-b", index: 1 })], new Map());
    const markup = renderToStaticMarkup(createElement(ObjectList, { cards, ...handlers }));
    // Two cards -> the first card's "上移" button and the second card's "下移" button are disabled.
    expect(markup.match(/aria-label="上移"[^>]*disabled/g) ?? []).toHaveLength(1);
    expect(markup.match(/aria-label="下移"[^>]*disabled/g) ?? []).toHaveLength(1);
  });

  it("family=path 的卡片，Effect 下拉只有一個選項 path", () => {
    const cards = buildCards([effect({ family: "path", effect: "path", d: "M 0 0" })], new Map());
    const markup = renderToStaticMarkup(createElement(ObjectList, { cards, ...handlers }));
    const options = [...markup.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1]);
    expect(options.filter((name) => name === "path")).toHaveLength(1);
  });
});

describe("EffectCard", () => {
  it("Duration/Delay 欄位的值直接反映 effect 的 duration/delay", () => {
    const cards = buildCards([effect({ duration: 1.2, delay: 0.3 })], new Map());
    const markup = renderToStaticMarkup(
      createElement(EffectCard, {
        card: cards[0],
        cardNumber: 1,
        isFirst: true,
        isLast: true,
        onChangeEffect: noop,
        onChangeStart: noop,
        onChangeDuration: noop,
        onChangeDelay: noop,
        onMoveUp: noop,
        onMoveDown: noop,
        onRemove: noop,
        onPreview: noop,
      }),
    );
    expect(markup).toContain('value="1.2"');
    expect(markup).toContain('value="0.3"');
  });
});

describe("Timeline", () => {
  it("空清單顯示同一份空態文案", () => {
    const markup = renderToStaticMarkup(
      createElement(Timeline, { cards: [], onMove: noop, onChangeDelay: noop, onChangeDuration: noop }),
    );
    expect(markup).toContain("No animations on this slide.");
  });

  it("bar 的 left/width 依 delay/duration × 80px/秒 計算", () => {
    const cards = buildCards([effect({ delay: 0.5, duration: 1 })], new Map());
    const markup = renderToStaticMarkup(
      createElement(Timeline, { cards, onMove: noop, onChangeDelay: noop, onChangeDuration: noop }),
    );
    // delay 0.5s * 80 = 40px; duration 1s * 80 = 80px.
    expect(markup).toContain("left:40px");
    expect(markup).toContain("width:80px");
  });

  it("duration 極短時 bar 寬度不小於最小可視寬度（24px）", () => {
    const cards = buildCards([effect({ duration: 0 })], new Map());
    const markup = renderToStaticMarkup(
      createElement(Timeline, { cards, onMove: noop, onChangeDelay: noop, onChangeDuration: noop }),
    );
    expect(markup).toContain("width:24px");
  });

  it("每一行標示卡片編號與 label", () => {
    const cards = buildCards([effect({ index: 0 }), effect({ target: "el-b", index: 1 })], new Map());
    const markup = renderToStaticMarkup(
      createElement(Timeline, { cards, onMove: noop, onChangeDelay: noop, onChangeDuration: noop }),
    );
    const numbers = [...markup.matchAll(/animate-timeline-bar-number">(\d+)</g)].map((m) => m[1]);
    expect(numbers).toEqual(["1", "2"]);
  });
});
