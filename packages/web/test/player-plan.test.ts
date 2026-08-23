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

  it("把隱藏目標接成一條 CSS 規則，opacity 設為 0", () => {
    expect(renderHideStyle(["el-a", "el-b"])).toBe("<style>#el-a,#el-b{opacity:0}</style>");
  });
});

describe("renderPlanScript", () => {
  it("把 plan 序列化成指定給 window.__COMOT_PLAN__ 的一行 script", () => {
    const plan = { steps: [], hidden: ["el-a"] };
    expect(renderPlanScript(plan)).toBe('window.__COMOT_PLAN__ = {"steps":[],"hidden":["el-a"]};');
  });
});
