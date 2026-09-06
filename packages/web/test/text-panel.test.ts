import { describe, expect, it } from "vitest";
import { textPanelInsertInput } from "../src/shell/dock/panels/TextPanel.js";

// NOOP-65r3 §Step 3 — `textPanelInsertInput` is the preset/align →
// `insertTextBox` input conversion pulled out of `TextPanel`'s `insert()`
// so it has a test independent of React/DOM. Values below are verbatim
// from `docs/design/prototype/comotion-logic-v3.js:203` (NOOP-65 計畫
// §3.8), computed by hand against a 1000×1000 canvas so every percentage
// in the source becomes its own literal pixel value.
describe("textPanelInsertInput", () => {
  it("body/left：留空文字用預設字串，位置與尺寸是 canvas 的百分比（原型 body 規格）", () => {
    const input = textPanelInsertInput("body", "left", "", { width: 1000, height: 1000 });
    expect(input).toEqual({
      text: "Body text", // spec.placeholderText — textarea left empty
      x: 84, // left align: lPercent = 8.4% of width 1000
      y: 420, // tPercent fixed at 42% of height 1000
      width: 500, // spec.width 50% of 1000
      fontSize: 22, // spec.size 2.2% of 1000
      fontWeight: 400,
      align: "left",
    });
  });

  it("title/center：非空文字保留原樣，置中位置從 50% - 寬度/2 起算（原型 title 規格）", () => {
    const input = textPanelInsertInput("title", "center", "我的標題", { width: 1000, height: 1000 });
    expect(input).toEqual({
      text: "我的標題", // non-empty text passes through unchanged
      x: 200, // center align: lPercent = 50 - 60/2 = 20% of width 1000
      y: 420,
      width: 600, // spec.width 60% of 1000
      fontSize: 52, // spec.size 5.2% of 1000
      fontWeight: 700,
      align: "center",
    });
  });
});
