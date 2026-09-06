import { describe, expect, it } from "vitest";
import {
  AUDIO_EXTENSIONS,
  computePlayerPlan,
  hideSelectorsFor,
  renderHideStyle,
  renderPlanScript,
  VIDEO_EXTENSIONS,
} from "../src/player-plan.js";
// Cross-package: the server's own MIME table must agree with this player's
// extension allow-list, or an extension the player accepts silently falls
// back to application/octet-stream on the wire (see the describe block
// below). Not aliased in vitest.config.ts, so imported by relative path —
// same convention this project already uses for other .ts-as-.js imports.
import { rawContentTypeFor } from "../../server/src/raw.js";

// Seam C's parent half (C3): markup in, plan out. All derivation reuses
// #26's parseEffects/deriveSteps — this module only shapes their output
// into the plan the runtime consumes, and never re-parses anything itself.

const NS = 'xmlns:comot="https://co-motion.dev/ns"';

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

describe("computePlayerPlan", () => {
  it("推導出步驟，並把每個 enter 目標列進 hidden", () => {
    const svg = slide(
      [
        '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
        '<comot:effect target="el-b" family="enter" effect="appear" start="on-click"/>',
      ].join("\n"),
    );

    const plan = computePlayerPlan(svg);

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
    });
  });

  it("同一目標出現兩次時，hidden 只列一次", () => {
    // Not a realistic effect list, but the dedupe rule must hold regardless.
    const svg = slide(
      [
        '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
        '<comot:effect target="el-a" family="enter" effect="appear" start="on-click"/>',
      ].join("\n"),
    );

    expect(computePlayerPlan(svg).hidden).toEqual(["el-a"]);
  });

  // [E2.T7]/D12: hidden means "not on screen when the slide opens" — only
  // true when a target's FIRST effect entry in the file is `enter`. An
  // element that exits before it ever gets an entrance effect was already
  // visible; pre-hiding it would be wrong.
  it("D12：一個目標的第一筆效果若不是 enter，就不列進 hidden，即使稍後有 enter", () => {
    const svg = slide(
      [
        '<comot:effect target="el-a" family="exit" effect="fade-out" start="on-click"/>',
        '<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>',
      ].join("\n"),
    );
    expect(computePlayerPlan(svg).hidden).toEqual([]);
  });

  it("沒有效果清單的投影片得到零步、空的 hidden", () => {
    expect(computePlayerPlan('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-bg"/></svg>')).toEqual({
      steps: [],
      hidden: [],
      hideSelectors: {},
      media: {},
    });
  });

  it("剖析失敗時把 effects.ts 原本的錯誤訊息原樣拋出", () => {
    // "build" is [E2.T7]'s stand-in fixture value for "a family this round
    // still does not implement" (exit is now real, D4) — same role the old
    // fixture's "exit" used to play.
    const svg = slide('<comot:effect target="el-a" family="build" effect="fade" start="on-click"/>');
    expect(() => computePlayerPlan(svg)).toThrow(/family.*build/);
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

  it("影片副檔名 .mp4 得到 kind: video，src 是 data-comot-media 原始值", () => {
    const svg = slideWithMedia(' data-comot-media="assets/intro.mp4"');
    expect(computePlayerPlan(svg).media).toEqual({
      "el-video": { src: "assets/intro.mp4", kind: "video" },
    });
  });

  it("音訊副檔名 .oga 得到 kind: audio", () => {
    const svg = slideWithMedia(' data-comot-media="assets/narration.oga"');
    expect(computePlayerPlan(svg).media).toEqual({
      "el-video": { src: "assets/narration.oga", kind: "audio" },
    });
  });

  it("media 效果的目標沒有 data-comot-media 時拋錯，訊息點名該目標", () => {
    const svg = slideWithMedia("");
    expect(() => computePlayerPlan(svg)).toThrow(/el-video/);
  });

  it(".ogg 不在允許清單中，拋錯並指出該用 .oga 或 .ogv", () => {
    const svg = slideWithMedia(' data-comot-media="assets/clip.ogg"');
    expect(() => computePlayerPlan(svg)).toThrow(/\.oga/);
    expect(() => computePlayerPlan(svg)).toThrow(/\.ogv/);
  });

  it("沒有 media 效果的投影片得到空的 media 物件", () => {
    const svg = slide("");
    expect(computePlayerPlan(svg).media).toEqual({});
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
    (id) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="${id}" family="media" effect="play" start="on-click"/>
    </comot:effects>
  </metadata>
  <rect id="${id}" data-comot-media="assets/clip.mp4"/>
</svg>`;

      const plan = computePlayerPlan(svg);

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
    // Not a bare object-literal assignment: see the "完整走過注入鏈路"
    // block below for why. This expected string is a known-good literal
    // (double JSON.stringify of the same plan, computed independently of
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

  it('target id 恰好是 "__proto__" 時，注入鏈路重建後的 plan.media 仍是真正的 own property', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="__proto__" family="media" effect="play" start="on-click"/>
    </comot:effects>
  </metadata>
  <rect id="__proto__" data-comot-media="assets/clip.mp4"/>
</svg>`;
    const plan = computePlayerPlan(svg);
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
