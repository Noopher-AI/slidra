// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { textPanelInsertInput } from "../src/shell/dock/panels/TextPanel.js";

// `textPanelInsertInput` is the preset/align → `insertTextBox` input
// conversion pulled out of `TextPanel`'s `insert()` so it has a test
// independent of React/DOM. Values below are verbatim from
// `docs/design/prototype/slidra-logic-v3.js:203`, computed by hand
// against a 1000×1000 canvas so every percentage in the source becomes its
// own literal pixel value.
describe("textPanelInsertInput", () => {
  it("body/left: empty text falls back to the default string, position and size are percentages of the canvas (per the prototype's body spec)", () => {
    const input = textPanelInsertInput("body", "left", "", { width: 1000, height: 1000 }, null);
    expect(input).toEqual({
      text: "Body text", // spec.placeholderText — textarea left empty
      x: 84, // left align: lPercent = 8.4% of width 1000
      y: 420, // tPercent fixed at 42% of height 1000
      width: 500, // spec.width 50% of 1000
      fontSize: 22, // spec.size 2.2% of 1000
      fontWeight: 400,
      align: "left",
      fill: "#1f1a1a", // null pageStyle → contrastFill(null) → white background → dark fill
    });
  });

  it("title/center: non-empty text passes through unchanged, centered position computed from 50% - width/2 (per the prototype's title spec)", () => {
    const input = textPanelInsertInput("title", "center", "My Title", { width: 1000, height: 1000 }, null);
    expect(input).toEqual({
      text: "My Title", // non-empty text passes through unchanged
      x: 200, // center align: lPercent = 50 - 60/2 = 20% of width 1000
      y: 420,
      width: 600, // spec.width 60% of 1000
      fontSize: 52, // spec.size 5.2% of 1000
      fontWeight: 700,
      align: "center",
      fill: "#1f1a1a", // null pageStyle → contrastFill(null) → white background → dark fill
    });
  });

  // accent takes priority over the computed contrast color — both need to
  // be visible in fill's behavior.
  it("fill uses accent when one is given, without computing a contrast color", () => {
    const input = textPanelInsertInput("body", "left", "x", { width: 1000, height: 1000 }, {
      background: "#101418",
      accent: "#ff00ff",
    });
    expect(input.fill).toBe("#ff00ff");
  });

  it("with no accent and a dark background, fill uses the light color computed by the contrast function", () => {
    const input = textPanelInsertInput("body", "left", "x", { width: 1000, height: 1000 }, {
      background: "#101418",
      accent: null,
    });
    expect(input.fill).toBe("#f4f6f8");
  });
});
