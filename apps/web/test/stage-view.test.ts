// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_PRESETS,
  initialZoomPan,
  setZoom,
  zoomAtPoint,
  zoomFit,
  panBy,
  formatZoomPercent,
  clientPointToContentPoint,
  initialHandState,
  toggleHand,
  pressSpace,
  releaseSpace,
  isHandActive,
} from "../src/shell/stage-view.js";

// ── Zoom ──────────────────────────────────────────────────────

describe("stage-view: initial zoom state", () => {
  it("initialZoomPan returns 100% zoom with pan at the origin", () => {
    const state = initialZoomPan();
    expect(state.zoom).toBe(1);
    expect(state.pan).toEqual({ x: 0, y: 0 });
  });
});

describe("stage-view: setZoom throws on illegal input", () => {
  it("throws Error for NaN", () => {
    expect(() => setZoom(initialZoomPan(), NaN)).toThrow(Error);
  });
  it("throws Error for a string (non-number type)", () => {
    expect(() => setZoom(initialZoomPan(), "120%" as unknown as number)).toThrow(Error);
  });
  it("throws Error for Infinity", () => {
    expect(() => setZoom(initialZoomPan(), Infinity)).toThrow(Error);
  });
});

describe("stage-view: setZoom silently clamps user input", () => {
  it("clamps 0.1 to the minimum 0.25", () => {
    const next = setZoom(initialZoomPan(), 0.1);
    expect(next.zoom).toBe(ZOOM_MIN);
    expect(next.zoom).toBe(0.25);
  });
  it("clamps 10 to the maximum 4.0", () => {
    const next = setZoom(initialZoomPan(), 10);
    expect(next.zoom).toBe(ZOOM_MAX);
    expect(next.zoom).toBe(4.0);
  });
  it("keeps a non-preset value like 0.334 exactly as-is, without snapping to a menu preset", () => {
    const next = setZoom(initialZoomPan(), 0.334);
    expect(next.zoom).toBe(0.334);
    expect(ZOOM_PRESETS).not.toContain(0.334);
  });
});

describe("stage-view: formatZoomPercent only rounds at the display layer", () => {
  it("displays 0.334 as 33%", () => {
    expect(formatZoomPercent(0.334)).toBe("33%");
  });
  it("displays 1 as 100%", () => {
    expect(formatZoomPercent(1)).toBe("100%");
  });
});

describe("stage-view: pan is unbounded (Figma-style, the slide can be panned entirely off-screen)", () => {
  it("panBy allows offsets of any magnitude, including negative ones", () => {
    const start = initialZoomPan();
    const next = panBy(panBy(start, -100000, 50000), -100000, 50000);
    expect(next.pan).toEqual({ x: -200000, y: 100000 });
  });
});

describe("stage-view: zoomAtPoint zooms anchored to the cursor (the content point under the cursor stays fixed)", () => {
  it("zoom 1→2 anchored at (100,50): pan computed by hand from the anchor invariant as (-100,-50)", () => {
    // Anchor invariant: contentPoint = (anchor - pan) / zoom stays equal
    // before and after zooming.
    // zoom=1, pan=(0,0) → contentPoint = (100-0)/1 = 100, (50-0)/1 = 50.
    // At zoom=2 we need 100 = (100 - newPan.x) / 2 → newPan.x = 100 - 200 = -100 (same for y = -50).
    const start = initialZoomPan();
    const next = zoomAtPoint(start, 2, { x: 100, y: 50 });
    expect(next.zoom).toBe(2);
    expect(next.pan).toEqual({ x: -100, y: -50 });
  });

  it("the content coordinate under the anchor stays unchanged across a zoom (invariant, verified via a different calculation rather than re-deriving the formula)", () => {
    const start = { zoom: 1.5, pan: { x: 40, y: -20 } };
    const anchor = { x: 300, y: 150 };
    const before = clientPointToContentPoint(start, anchor);
    const after = zoomAtPoint(start, 3, anchor);
    const afterContent = clientPointToContentPoint(after, anchor);
    expect(afterContent.x).toBeCloseTo(before.x, 10);
    expect(afterContent.y).toBeCloseTo(before.y, 10);
  });
});

describe("stage-view: zoomFit resets to 100% and centers", () => {
  it("returns to the initial state from any zoom/pan state", () => {
    const arbitrary = { zoom: 3.2, pan: { x: 500, y: -200 } };
    expect(zoomFit(arbitrary)).toEqual(initialZoomPan());
  });
});

describe("stage-view: clientPointToContentPoint (coordinate conversion for a not-yet-used overlay)", () => {
  it("at zoom=1, pan=(0,0), screen coordinates equal content coordinates", () => {
    expect(clientPointToContentPoint(initialZoomPan(), { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });
  it("at zoom=2, pan=(10,0), converts by definition as (client - pan) / zoom", () => {
    const state = { zoom: 2, pan: { x: 10, y: 0 } };
    expect(clientPointToContentPoint(state, { x: 30, y: 8 })).toEqual({ x: 10, y: 4 });
  });
});

// ── Hand mode / temporary hand via Space ─────────────────────────

describe("stage-view: hand-mode initial state", () => {
  it("initialHandState has hand and spaceHeld both false", () => {
    const state = initialHandState();
    expect(state.hand).toBe(false);
    expect(state.spaceHeld).toBe(false);
    expect(isHandActive(state)).toBe(false);
  });
});

describe("stage-view: toggleHand button toggling", () => {
  it("off to on: hand=true, and reports selectionCleared=true (the \"hand mode\" scenario in 05-INTERACTIONS.feature)", () => {
    const { state, selectionCleared } = toggleHand(initialHandState());
    expect(state.hand).toBe(true);
    expect(selectionCleared).toBe(true);
  });

  it("on to off: hand=false, and does not report a cleared selection", () => {
    const on = toggleHand(initialHandState()).state;
    const { state, selectionCleared } = toggleHand(on);
    expect(state.hand).toBe(false);
    expect(selectionCleared).toBe(false);
  });
});

describe("stage-view: pressSpace/releaseSpace temporary hand", () => {
  it("holding Space makes isHandActive true, even when the button's own hand state is false", () => {
    const pressed = pressSpace(initialHandState());
    expect(pressed.hand).toBe(false);
    expect(pressed.spaceHeld).toBe(true);
    expect(isHandActive(pressed)).toBe(true);
  });

  it("releasing Space restores isHandActive to false, when the button was originally off", () => {
    const pressed = pressSpace(initialHandState());
    const released = releaseSpace(pressed);
    expect(released.spaceHeld).toBe(false);
    expect(isHandActive(released)).toBe(false);
  });

  it("releasing Space keeps hand on when the button was already on (pressed ✋ first, then Space)", () => {
    const handOn = toggleHand(initialHandState()).state;
    const pressed = pressSpace(handOn);
    expect(isHandActive(pressed)).toBe(true);
    const released = releaseSpace(pressed);
    expect(released.hand).toBe(true);
    expect(isHandActive(released)).toBe(true);
  });

  it("Space must not enable hand mode while focus is in a text input", () => {
    const pressed = pressSpace(initialHandState(), { targetIsTextInput: true });
    expect(pressed.spaceHeld).toBe(false);
    expect(isHandActive(pressed)).toBe(false);
  });

  it("releaseSpace is a safe no-op on a state where Space isn't held (safe to call directly on window blur, without checking state first)", () => {
    const state = initialHandState();
    expect(releaseSpace(state)).toEqual(state);
  });
});
