import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_EXTENSIONS,
  computePlayerPlan,
  hideSelectorsFor,
  renderHideStyle,
  renderPlanScript,
  stageEmbedsFor,
  stageMediaFor,
  VIDEO_EXTENSIONS,
} from "../src/player-plan.js";
import { invalidateSlideEffectPlans } from "../src/effects.js";
import type { Effect } from "../src/effects.js";
// Cross-package: the server's own MIME table must agree with this player's
// extension allow-list, or an extension the player accepts silently falls
// back to application/octet-stream on the wire (see the describe block
// below). Not aliased in vitest.config.ts, so imported by relative path —
// same convention this project already uses for other .ts-as-.js imports.
import { rawContentTypeFor } from "../../server/src/raw.js";

// Seam C's parent half (C3): markup in, plan out. `computePlayerPlan` no
// longer derives `steps`/`effects` from the markup itself ([E4.T7]): that
// computation now lives server-side (`effect list`'s `data`, plan 4.1),
// fetched here through `fetchSlideEffectPlan`'s `/api/effects/` route
// client. Every test below stubs that route with `mockEffectsRoute` rather
// than relying on the `<comot:effect>` markup embedded in its fixture SVGs
// (kept in the fixtures for readability only — computePlayerPlan itself
// never reads it anymore). The rest of this module's derivation
// (hidden/media/stageMedia/embedIds) is still a pure, synchronous function
// of `svgMarkup` alone, unaffected by this ticket.

const NS = 'xmlns:comot="https://co-motion.dev/ns"';
const SLIDE_PATH = "slides/001.svg";

function slide(effectLines: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      ${effectLines}
    </comot:effects>
  </metadata>
  <rect id="el-a"/>
  <rect id="el-b"/>
  <rect id="el-bg"/>
</svg>`;
}

interface EffectFixture {
  target: string;
  family: Effect["family"];
  effect: Effect["effect"];
  start: Effect["start"];
  duration?: number;
  delay?: number;
  d?: string;
}

const DEFAULT_TRANSITION = { enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } };

/**
 * Groups an ordered, 1-based-indexed effect list into steps exactly like
 * `effect list`'s server-side step derivation — a small, stable
 * reimplementation kept ONLY for building this file's stub route
 * responses. `computePlayerPlan` itself no longer derives steps at all
 * (that is the whole point of this ticket); this helper exists so a test
 * only has to state its effect list once, not the list AND its grouping
 * separately.
 */
function groupIntoSteps<T extends { start: Effect["start"] }>(effects: T[]): Array<{ effects: T[] }> {
  const steps: Array<{ effects: T[] }> = [];
  for (const effect of effects) {
    if (effect.start === "on-click") {
      steps.push({ effects: [effect] });
    } else {
      steps[steps.length - 1]!.effects.push(effect);
    }
  }
  return steps;
}

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  invalidateSlideEffectPlans();
});

/** Stubs `GET /api/effects/*` (the only route `computePlayerPlan`'s tests ever hit) with a fixed, legal effect list, wire-shaped with 1-based `index` and grouped into steps the same way the real route does. */
function mockEffectsRoute(effects: EffectFixture[]): void {
  const wireEffects = effects.map((effect, i) => ({ duration: 0.6, delay: 0, ...effect, index: i + 1 }));
  const wireSteps = groupIntoSteps(wireEffects);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ effects: wireEffects, steps: wireSteps, transition: DEFAULT_TRANSITION }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** Stubs `GET /api/effects/*` with a damaged-list (or otherwise non-2xx) response. */
function mockEffectsRouteError(message: string, status = 500): void {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } }),
  );
}

describe("computePlayerPlan", () => {
  it("推導出步驟，並把每個 enter 目標列進 hidden", async () => {
    const svg = slide(
      [
        '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
        '<comot:effect target="el-b" family="enter" effect="appear" start="on-click"/>',
      ].join("\n"),
    );
    mockEffectsRoute([
      { target: "el-a", family: "enter", effect: "fade", start: "on-click" },
      { target: "el-b", family: "enter", effect: "appear", start: "on-click" },
    ]);

    const plan = await computePlayerPlan(svg, SLIDE_PATH);

    expect(plan).toEqual({
      steps: [
        {
          effects: [
            { target: "el-a", family: "enter", effect: "fade", start: "on-click", duration: 0.6, delay: 0, index: 0 },
          ],
        },
        {
          effects: [
            { target: "el-b", family: "enter", effect: "appear", start: "on-click", duration: 0.6, delay: 0, index: 1 },
          ],
        },
      ],
      hidden: ["el-a", "el-b"],
      hideSelectors: { "el-a": "#el-a", "el-b": "#el-b" },
      media: {},
      stageMedia: {},
      embedIds: [],
    });
  });

  it("同一目標出現兩次時，hidden 只列一次", async () => {
    // Not a realistic effect list, but the dedupe rule must hold regardless.
    const svg = slide(
      [
        '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
        '<comot:effect target="el-a" family="enter" effect="appear" start="on-click"/>',
      ].join("\n"),
    );
    mockEffectsRoute([
      { target: "el-a", family: "enter", effect: "fade", start: "on-click" },
      { target: "el-a", family: "enter", effect: "appear", start: "on-click" },
    ]);

    expect((await computePlayerPlan(svg, SLIDE_PATH)).hidden).toEqual(["el-a"]);
  });

  // [E2.T7]/D12: hidden means "not on screen when the slide opens" — only
  // true when a target's FIRST effect entry in the file is `enter`. An
  // element that exits before it ever gets an entrance effect was already
  // visible; pre-hiding it would be wrong.
  it("D12：一個目標的第一筆效果若不是 enter，就不列進 hidden，即使稍後有 enter", async () => {
    const svg = slide(
      [
        '<comot:effect target="el-a" family="exit" effect="fade-out" start="on-click"/>',
        '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
      ].join("\n"),
    );
    mockEffectsRoute([
      { target: "el-a", family: "exit", effect: "fade-out", start: "on-click" },
      { target: "el-a", family: "enter", effect: "fade", start: "on-click" },
    ]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).hidden).toEqual([]);
  });

  it("stageEmbedsFor 收錄第三方嵌入，而 stageMedia 明確跳過它們", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<g id="el-embed" data-comot-media="https://www.youtube-nocookie.com/embed/MtKyexX-GQc" data-comot-type="video" data-comot-embed="youtube"/>' +
      '<g id="el-file" data-comot-media="../assets/clip.webm" data-comot-type="video"/>' +
      "</svg>";
    mockEffectsRoute([]);

    expect(stageEmbedsFor(svg)).toEqual({
      "el-embed": { provider: "youtube", url: "https://www.youtube-nocookie.com/embed/MtKyexX-GQc" },
    });
    expect(Object.keys(stageMediaFor(svg))).toEqual(["el-file"]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).embedIds).toEqual(["el-embed"]);
  });

  it("media 效果指向嵌入時：不進 media cue、不因為沒有副檔名而拋錯，仍然是一個步驟", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<metadata><comot:effects xmlns:comot="https://co-motion.dev/ns">' +
      '<comot:effect target="el-embed" family="media" effect="play" start="on-click"/>' +
      "</comot:effects></metadata>" +
      '<g id="el-embed" data-comot-media="https://www.youtube-nocookie.com/embed/MtKyexX-GQc" data-comot-type="video" data-comot-embed="youtube"/>' +
      "</svg>";
    mockEffectsRoute([{ target: "el-embed", family: "media", effect: "play", start: "on-click" }]);

    const plan = await computePlayerPlan(svg, SLIDE_PATH);
    expect(plan.media).toEqual({});
    expect(plan.embedIds).toEqual(["el-embed"]);
    expect(plan.steps).toHaveLength(1);
  });

  it("不認得的嵌入來源被跳過，而不是拋錯", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<g id="el-x" data-comot-media="https://vimeo.com/1" data-comot-embed="vimeo"/>' +
      "</svg>";
    expect(stageEmbedsFor(svg)).toEqual({});
  });

  it("stageMedia 收錄每個 data-comot-media 元素，包含沒有任何效果指向它的那些", async () => {
    mockEffectsRoute([]);
    const plan = await computePlayerPlan(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<g id="el-no-effect" data-comot-media="../assets/clip.webm" data-comot-type="video"/>' +
        "</svg>",
      SLIDE_PATH,
    );

    expect(plan.media).toEqual({});
    expect(plan.stageMedia).toEqual({ "el-no-effect": { src: "../assets/clip.webm", kind: "video" } });
  });

  it("沒有效果清單的投影片得到零步、空的 hidden", async () => {
    mockEffectsRoute([]);
    expect(
      await computePlayerPlan('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-bg"/></svg>', SLIDE_PATH),
    ).toEqual({
      steps: [],
      hidden: [],
      hideSelectors: {},
      media: {},
      stageMedia: {},
      embedIds: [],
    });
  });

  it("剖析失敗時把路由回應的錯誤訊息原樣拋出", async () => {
    // "build" is [E2.T7]'s stand-in fixture value for "a family this round
    // still does not implement" (exit is now real, D4) — same role the old
    // fixture's "exit" used to play.
    const svg = slide('<comot:effect target="el-a" family="build" effect="fade" start="on-click"/>');
    mockEffectsRouteError("第 1 項（target 為 el-a） 的 family 值「build」尚未實作。");
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/family.*build/);
  });
});

describe("computePlayerPlan：cache", () => {
  it("同一個 slidePath 連呼叫兩次，fake fetch 只被呼叫一次", async () => {
    const svg = slide("");
    mockEffectsRoute([]);

    await computePlayerPlan(svg, SLIDE_PATH);
    await computePlayerPlan(svg, SLIDE_PATH);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidateSlideEffectPlans() 之後再呼叫，fake fetch 被呼叫第二次", async () => {
    const svg = slide("");
    mockEffectsRoute([]);

    await computePlayerPlan(svg, SLIDE_PATH);
    invalidateSlideEffectPlans();
    await computePlayerPlan(svg, SLIDE_PATH);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("renderHideStyle", () => {
  it("沒有隱藏目標時回傳空字串", () => {
    expect(renderHideStyle([])).toBe("");
  });

  // [E2.T7]/D7: one rule per id (not one rule for a joined selector list)
  // — the runtime removes a single id's rule by rewriting this exact
  // stylesheet's textContent from `plan.hideSelectors`, so the two must
  // agree on what "one id's rule" looks like. The `id="comot-hide"` on the
  // `<style>` itself is what the runtime looks the element up by.
  it("把每個隱藏目標各自接成一條 CSS 規則，opacity 設為 0 且帶 !important", () => {
    // !important is load-bearing (gate review round 2, P2): a slide
    // element can carry its own inline opacity, which normally beats an
    // injected stylesheet rule regardless of that rule's specificity —
    // without !important here, such an element would flash fully visible
    // at the very start of play, exactly the bug this rule exists to stop.
    expect(renderHideStyle(["el-a", "el-b"])).toBe(
      '<style id="comot-hide">#el-a{opacity:0 !important}#el-b{opacity:0 !important}</style>',
    );
  });

  it("id 以數字開頭時，跳脫成合法的 CSS 識別碼", () => {
    // A naive "escape every non-alphanumeric character" regex leaves a
    // leading digit untouched, producing the syntactically invalid
    // selector `#1-title` — the browser drops the whole rule, and that
    // element starts visible (gate review round 2, P2). CSS identifiers
    // cannot start with an unescaped digit; it must be hex-escaped.
    expect(renderHideStyle(["1-title"])).toBe('<style id="comot-hide">#\\31 -title{opacity:0 !important}</style>');
  });

  it("id 就是單一個連字號時，跳脫成 \\-", () => {
    expect(renderHideStyle(["-"])).toBe('<style id="comot-hide">#\\-{opacity:0 !important}</style>');
  });
});

// [E2.T7]/D7: `plan.hideSelectors` is the same escaped-selector table
// `renderHideStyle` derives its rules from — computed once, here, so the
// runtime never re-implements `cssEscapeId`.
describe("hideSelectorsFor", () => {
  it("每個 id 對應到它自己已跳脫的 CSS id 選擇器", () => {
    expect(hideSelectorsFor(["el-a", "1-title"])).toEqual({ "el-a": "#el-a", "1-title": "#\\31 -title" });
  });

  it("空清單得到空物件", () => {
    expect(hideSelectorsFor([])).toEqual({});
  });
});

describe("computePlayerPlan：media", () => {
  function slideWithMedia(mediaAttr: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="el-video" family="media" effect="play" start="on-click"/>
    </comot:effects>
  </metadata>
  <image id="el-video"${mediaAttr}/>
</svg>`;
  }

  const mediaEffectFixture: EffectFixture = { target: "el-video", family: "media", effect: "play", start: "on-click" };

  it("影片副檔名 .mp4 得到 kind: video，src 是 data-comot-media 原始值", async () => {
    const svg = slideWithMedia(' data-comot-media="assets/intro.mp4"');
    mockEffectsRoute([mediaEffectFixture]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).media).toEqual({
      "el-video": { src: "assets/intro.mp4", kind: "video" },
    });
  });

  it("音訊副檔名 .oga 得到 kind: audio", async () => {
    const svg = slideWithMedia(' data-comot-media="assets/narration.oga"');
    mockEffectsRoute([mediaEffectFixture]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).media).toEqual({
      "el-video": { src: "assets/narration.oga", kind: "audio" },
    });
  });

  it("media 效果的目標沒有 data-comot-media 時拋錯，訊息點名該目標", async () => {
    const svg = slideWithMedia("");
    mockEffectsRoute([mediaEffectFixture]);
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/el-video/);
  });

  it(".ogg 不在允許清單中，拋錯並指出該用 .oga 或 .ogv", async () => {
    const svg = slideWithMedia(' data-comot-media="assets/clip.ogg"');
    mockEffectsRoute([mediaEffectFixture]);
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/\.oga/);
    mockEffectsRoute([mediaEffectFixture]);
    await expect(computePlayerPlan(svg, SLIDE_PATH)).rejects.toThrow(/\.ogv/);
  });

  it("沒有 media 效果的投影片得到空的 media 物件", async () => {
    const svg = slide("");
    mockEffectsRoute([]);
    expect((await computePlayerPlan(svg, SLIDE_PATH)).media).toEqual({});
  });

  // Codex review gate round 1, P2: SVG element ids are author-controlled,
  // untrusted strings (ADR-0010) — nothing stops a legal id from being
  // "__proto__". A plain `{}` built up via `media[target] = cue` does not
  // create an own property for that key: assigning to "__proto__" on an
  // object whose prototype chain still has Object.prototype's __proto__
  // accessor instead reassigns the object's own [[Prototype]], so the cue
  // silently never becomes a real, enumerable, own "media" entry — even
  // though later code might still happen to read the right value back via
  // that same accessor (a coincidence this test does not rely on).
  // hasOwnProperty is the direct, unambiguous check for "was this actually
  // stored as data".
  // [E2.T7] 測試盤點 6.2.B: merged with the former "constructor" id test
  // (same layer, same behaviour, only the string differed) — both ids now
  // asserted here so neither input is lost. The layer that actually catches
  // a real regression for "constructor" is player-runtime.test.ts:473,
  // which is kept as-is.
  it.each(["__proto__", "constructor"])(
    'target id 恰好是 "%s" 時，仍正確產生對應的 media cue（不是被原型污染吃掉的空物件）',
    async (id) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="${id}" family="media" effect="play" start="on-click"/>
    </comot:effects>
  </metadata>
  <rect id="${id}" data-comot-media="assets/clip.mp4"/>
</svg>`;
      mockEffectsRoute([{ target: id, family: "media", effect: "play", start: "on-click" }]);

      const plan = await computePlayerPlan(svg, SLIDE_PATH);

      expect(Object.prototype.hasOwnProperty.call(plan.media, id)).toBe(true);
      expect(plan.media[id]).toEqual({ src: "assets/clip.mp4", kind: "video" });
    },
  );
});

describe("允許清單與 server 的 MIME 表必須一致（ticket #30 review round 2）", () => {
  // Both extensions this module hard-codes into VIDEO_EXTENSIONS/
  // AUDIO_EXTENSIONS must resolve to a real Content-Type on the server side
  // — an extension the player is willing to play but the server serves as
  // application/octet-stream is exactly the failure mode #23 worried about
  // (some browsers refuse to decode media without a real Content-Type,
  // some sniff bytes and decode anyway — "green on one machine, red on
  // another"). This test reads both allow-lists live, not a copy of either,
  // so it actually catches the next person adding an extension to one side
  // and forgetting the other.
  it.each([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])(
    "player 允許的副檔名 %s 在 server 端得到非 application/octet-stream 的 Content-Type",
    (extension) => {
      expect(rawContentTypeFor(`assets/clip${extension}`)).not.toBe("application/octet-stream");
    },
  );
});

describe("renderPlanScript", () => {
  it("把 plan 序列化成指定給 window.__COMOT_PLAN__ 的一行 script，透過 JSON.parse 重建，不是物件字面量", () => {
    // Not a bare object-literal assignment: see the "完整走過注入鏈路" block
    // below for why. This expected string is a known-good literal (double
    // JSON.stringify of the same plan, computed independently of
    // renderPlanScript's own implementation), not a value recomputed the
    // way the code computes it.
    const plan = { steps: [], hidden: ["el-a"] };
    expect(renderPlanScript(plan)).toBe(
      "window.__COMOT_PLAN__ = JSON.parse(\"{\\\"steps\\\":[],\\\"hidden\\\":[\\\"el-a\\\"],\\\"startStep\\\":-1}\");",
    );
  });

  // #46 decision 一: startStep defaults to -1 ("this slide has not been
  // advanced yet") when the caller passes nothing — today's behaviour,
  // unchanged for every existing call site.
  it("不帶第二個參數時，startStep 預設為 -1", () => {
    const plan = { steps: [], hidden: [] };
    expect(renderPlanScript(plan)).toContain('\\"startStep\\":-1');
  });

  // #46 decision 一/二: a caller wanting play to start mid-slide (retreat
  // landing on the last step) passes an explicit startStep.
  it("帶入 startStep 時，序列化結果帶著該值", () => {
    const plan = { steps: [], hidden: [] };
    expect(renderPlanScript(plan, 2)).toContain('\\"startStep\\":2');
  });
});

// Codex review gate round 1 follow-up: computePlayerPlan()'s own return
// value already round-trips "__proto__" as a real own property (see the
// "computePlayerPlan：media" tests above, fixed by Object.create(null) in
// mediaCuesFor) — but that is only the parent side of the wire.
// renderPlanScript()'s output is injected into the play iframe as raw
// script text and evaluated there; if that text reconstructs the plan via
// a bare object-literal assignment, ECMAScript's own object-literal syntax
// gives a non-computed `"__proto__": value` key special treatment — it
// sets [[Prototype]] instead of creating an own property — regardless of
// how carefully the value was built on this side. These tests exercise
// the *whole* chain: computePlayerPlan() -> renderPlanScript() -> a real
// JS engine evaluating that exact text against a window stand-in (not a
// mock of what evaluation "should" do) -> reading the reconstructed plan
// back.
describe("renderPlanScript：完整走過注入鏈路的重建（不只是 computePlayerPlan 的回傳值）", () => {
  function evalInjectedScript(script: string): { steps: unknown; hidden: unknown; media: Record<string, unknown> } {
    const fakeWindow: { __COMOT_PLAN__?: unknown } = {};
    // eslint-disable-next-line no-new-func -- deliberately evaluating the
    // exact production script text with a real JS engine, the same thing
    // the play iframe does.
    new Function("window", script)(fakeWindow);
    return fakeWindow.__COMOT_PLAN__ as { steps: unknown; hidden: unknown; media: Record<string, unknown> };
  }

  it('target id 恰好是 "__proto__" 時，注入鏈路重建後的 plan.media 仍是真正的 own property', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="__proto__" family="media" effect="play" start="on-click"/>
    </comot:effects>
  </metadata>
  <rect id="__proto__" data-comot-media="assets/clip.mp4"/>
</svg>`;
    mockEffectsRoute([{ target: "__proto__", family: "media", effect: "play", start: "on-click" }]);
    const plan = await computePlayerPlan(svg, SLIDE_PATH);
    const script = renderPlanScript(plan);

    const reconstructed = evalInjectedScript(script);

    expect(Object.prototype.hasOwnProperty.call(reconstructed.media, "__proto__")).toBe(true);
    expect(reconstructed.media["__proto__"]).toEqual({ src: "assets/clip.mp4", kind: "video" });
    // hidden/steps are never keyed by untrusted ids (hidden is a plain
    // string[], steps is an array of {effects: Effect[]} with fixed
    // property names) — confirmed unaffected, not just assumed.
    expect(reconstructed.hidden).toEqual(plan.hidden);
    expect(reconstructed.steps).toEqual(plan.steps);
  });
});

describe("stageMediaFor（[E2.T17] plan §4.4：舞台媒體層的 kind 判定，留在 parent）", () => {
  it("元素有 data-comot-type 時，用它當 kind（不看副檔名）", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g id="el-1" data-comot-type="audio" data-comot-media="assets/clip.mp4"></g>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({ "el-1": { src: "assets/clip.mp4", kind: "audio" } });
  });

  it("沒有 data-comot-type 時，靠副檔名判斷（media-deck/demo 004 兩份既有 fixture 能運作的唯一理由）", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <rect id="el-1" data-comot-media="../assets/clip.webm"/>
  <circle id="el-2" data-comot-media="../assets/narration.oga"/>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({
      "el-1": { src: "../assets/clip.webm", kind: "video" },
      "el-2": { src: "../assets/narration.oga", kind: "audio" },
    });
  });

  it("data-comot-media 指向圖片副檔名時跳過，不拋錯（style-panel-deck 的 PNG）", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <image id="el-1" data-comot-media="../assets/photo.png"/>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({});
  });

  it("副檔名不認得時跳過，不拋錯", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <g id="el-1" data-comot-media="assets/mystery.xyz"></g>
</svg>`;
    expect(stageMediaFor(svg)).toEqual({});
  });

  it('id 是 "__proto__" 時仍正確產生對應項（不是被原型污染吃掉的空物件）', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <rect id="__proto__" data-comot-media="assets/clip.mp4"/>
</svg>`;
    const result = stageMediaFor(svg);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(result["__proto__"]).toEqual({ src: "assets/clip.mp4", kind: "video" });
  });

  it("沒有任何媒體元素時回傳空表", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g id="el-1"><rect width="10" height="10"/></g></svg>`;
    expect(stageMediaFor(svg)).toEqual({});
  });
});
