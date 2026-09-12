import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Effect } from "../src/effects.js";
import { buildCards, cardLabel, EffectCard, type EffectCardData } from "../src/shell/side/animate/cards.js";
import { ObjectList } from "../src/shell/side/animate/ObjectList.js";
import type { TargetInfo } from "../src/shell/side/animate/useSlideEffects.js";
import { PageTransitionView } from "../src/shell/side/animate/PageTransitionView.js";

/**
 * §6.4: the panel's public boundary is `renderToStaticMarkup` output (same
 * convention `stage-overlays.test.ts` already uses) — never an internal
 * call count or React fibre inspection.
 */

function effect(overrides: Partial<Effect> = {}): Effect {
  return { target: "el-a", family: "enter", effect: "fade", start: "on-click", duration: 0.6, delay: 0, index: 0, ...overrides };
}

function noop(): void {
  /* renderToStaticMarkup never fires handlers — these exist only to satisfy prop types. */
}

describe("buildCards / cardLabel", () => {
  it("a plain element: falls back to showing the target id when there is no targetInfo", () => {
    const cards = buildCards([effect()], new Map());
    expect(cardLabel(cards[0], 1)).toBe("el-a");
  });

  it("a plain element: shows the name when targetInfo has data-slidra-name", () => {
    const info = new Map<string, TargetInfo>([["el-a", { name: "Title", groupMemberCount: null }]]);
    const cards = buildCards([effect()], info);
    expect(cardLabel(cards[0], 1)).toBe("Title");
  });

  it("shows \"Group N (n)\" when the target is a group, where n is the member count, not the name", () => {
    const info = new Map<string, TargetInfo>([["el-group", { name: "Group", groupMemberCount: 3 }]]);
    const cards = buildCards([effect({ target: "el-group" })], info);
    expect(cardLabel(cards[0], 2)).toBe("Group 2 (3)");
  });

  it("carries index through to the card data, for CLI/preview addressing", () => {
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

  it("shows the prototype's empty-state copy verbatim for an empty list", () => {
    const markup = renderToStaticMarkup(createElement(ObjectList, { cards: [], ...handlers }));
    expect(markup).toContain("No animations on this slide.");
  });

  it("one card per effect, numbered in list order (1-based)", () => {
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

  it("the first card's move-up button is disabled, and the last card's move-down button is disabled", () => {
    const cards = buildCards([effect({ index: 0 }), effect({ target: "el-b", index: 1 })], new Map());
    const markup = renderToStaticMarkup(createElement(ObjectList, { cards, ...handlers }));
    // Two cards -> the first card's "move up" button and the second card's "move down" button are disabled.
    expect(markup.match(/aria-label="Move Up"[^>]*disabled/g) ?? []).toHaveLength(1);
    expect(markup.match(/aria-label="Move Down"[^>]*disabled/g) ?? []).toHaveLength(1);
  });

  it("for a family=path card, the Effect dropdown has only one option, path", () => {
    const cards = buildCards([effect({ family: "path", effect: "path", d: "M 0 0" })], new Map());
    const markup = renderToStaticMarkup(createElement(ObjectList, { cards, ...handlers }));
    const options = [...markup.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1]);
    expect(options.filter((name) => name === "path")).toHaveLength(1);
  });
});

describe("EffectCard", () => {
  it("the Duration/Delay fields reflect the effect's duration/delay directly", () => {
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

describe("PageTransitionView (§4.7)", () => {
  const baseTransition = {
    enter: { effect: "none" as const, duration: 0.6 },
    exit: { effect: "none" as const, duration: 0.5 },
  };
  const handlers = {
    onChangeEnterEffect: noop,
    onChangeEnterDuration: noop,
    onChangeExitEffect: noop,
    onChangeExitDuration: noop,
    onApplyAll: noop,
  };

  it("Enter/Exit each have four effect cards, copy matching the prototype verbatim (None/Fade/Slide in/Zoom in, and on the Exit side Slide out/Zoom out)", () => {
    const markup = renderToStaticMarkup(createElement(PageTransitionView, { transition: baseTransition, ...handlers }));
    expect(markup).toContain("Slide in");
    expect(markup).toContain("Zoom in");
    expect(markup).toContain("Slide out");
    expect(markup).toContain("Zoom out");
    expect(markup).toContain("Apply to all slides");
  });

  it("the current enter/exit effect card carries the selected class, and the rest do not", () => {
    const transition = { enter: { effect: "fade" as const, duration: 0.6 }, exit: { effect: "zoom" as const, duration: 0.5 } };
    const markup = renderToStaticMarkup(createElement(PageTransitionView, { transition, ...handlers }));
    expect(markup).toMatch(/animate-page-effect-card selected"[^>]*>Fade</);
    expect(markup).toMatch(/animate-page-effect-card selected"[^>]*>Zoom out</);
    expect(markup).not.toMatch(/selected"[^>]*>None</);
  });

  it("shows {n}s to the right of the title, reflecting the actual duration value directly", () => {
    const transition = { enter: { effect: "none" as const, duration: 0.8 }, exit: { effect: "none" as const, duration: 0.5 } };
    const markup = renderToStaticMarkup(createElement(PageTransitionView, { transition, ...handlers }));
    expect(markup).toContain("0.8s");
  });

  it("§4.7: when the current value is outside the slider's 0.2-1.5 range, the numeric text still shows the true value (3s), while the slider's own value is clamped to the endpoint", () => {
    const transition = { enter: { effect: "none" as const, duration: 3 }, exit: { effect: "none" as const, duration: 0.5 } };
    const markup = renderToStaticMarkup(createElement(PageTransitionView, { transition, ...handlers }));
    expect(markup).toContain("3s");
    expect(markup).toContain('value="1.5"'); // the slider's own value is clamped to the endpoint
  });

  it("the slider's min/max/step match the prototype's 0.2/1.5/0.1", () => {
    const markup = renderToStaticMarkup(createElement(PageTransitionView, { transition: baseTransition, ...handlers }));
    expect(markup).toContain('min="0.2"');
    expect(markup).toContain('max="1.5"');
    expect(markup).toContain('step="0.1"');
  });
});
