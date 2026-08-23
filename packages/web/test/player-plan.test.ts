import { describe, expect, it } from "vitest";
import { computePlayerPlan, renderHideStyle, renderPlanScript } from "../src/player-plan.js";

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
        { effects: [{ target: "el-a", family: "enter", effect: "fade", start: "on-click" }] },
        { effects: [{ target: "el-b", family: "enter", effect: "appear", start: "on-click" }] },
      ],
      hidden: ["el-a", "el-b"],
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

  it("沒有效果清單的投影片得到零步、空的 hidden", () => {
    expect(computePlayerPlan('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-bg"/></svg>')).toEqual({
      steps: [],
      hidden: [],
      media: {},
    });
  });

  it("剖析失敗時把 effects.ts 原本的錯誤訊息原樣拋出", () => {
    const svg = slide('<comot:effect target="el-a" family="exit" effect="fade" start="on-click"/>');
    expect(() => computePlayerPlan(svg)).toThrow(/family.*exit/);
  });
});

describe("renderHideStyle", () => {
  it("沒有隱藏目標時回傳空字串", () => {
    expect(renderHideStyle([])).toBe("");
  });

  it("把隱藏目標接成一條 CSS 規則，opacity 設為 0 且帶 !important", () => {
    // !important is load-bearing (gate review round 2, P2): a slide
    // element can carry its own inline opacity, which normally beats an
    // injected stylesheet rule regardless of that rule's specificity —
    // without !important here, such an element would flash fully visible
    // at the very start of play, exactly the bug this rule exists to stop.
    expect(renderHideStyle(["el-a", "el-b"])).toBe("<style>#el-a,#el-b{opacity:0 !important}</style>");
  });

  it("id 以數字開頭時，跳脫成合法的 CSS 識別碼", () => {
    // A naive "escape every non-alphanumeric character" regex leaves a
    // leading digit untouched, producing the syntactically invalid
    // selector `#1-title` — the browser drops the whole rule, and that
    // element starts visible (gate review round 2, P2). CSS identifiers
    // cannot start with an unescaped digit; it must be hex-escaped.
    expect(renderHideStyle(["1-title"])).toBe("<style>#\\31 -title{opacity:0 !important}</style>");
  });

  it("id 就是單一個連字號時，跳脫成 \\-", () => {
    expect(renderHideStyle(["-"])).toBe("<style>#\\-{opacity:0 !important}</style>");
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
});

describe("renderPlanScript", () => {
  it("把 plan 序列化成指定給 window.__COMOT_PLAN__ 的一行 script", () => {
    const plan = { steps: [], hidden: ["el-a"] };
    expect(renderPlanScript(plan)).toBe('window.__COMOT_PLAN__ = {"steps":[],"hidden":["el-a"]};');
  });
});
