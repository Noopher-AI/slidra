// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { requireBuilt, startServerFor, openApp, type StartedServer } from "./helpers/launch.js";

/**
 * e2e coverage for the 5 "stage navigation" scenarios in
 * docs/design/docs/05-INTERACTIONS.feature. This only verifies that these
 * states actually land on the DOM (transform, cursor, the percentage text)
 * — the zoom/pan/hand-drag state transitions themselves are already
 * exhaustively boundary-tested in apps/web/test/stage-view.test.ts, so the
 * clamping logic isn't retested here.
 *
 * Wheel-zoom/pan and hand-mode dragging over the slide body (`.stage`/inside
 * the iframe, the vast majority of the screen area) now take effect through
 * canvas.ts's `subscribeStageInput` (selection-runtime.js is the actual
 * source), no longer responding only over the `.canvas-area` gutter
 * (padding) background. The main assertions in the "wheel zoom", "wheel
 * pan", and "hand mode" scenarios below are driven at `slidePoint()` (dead
 * centre of the slide); `gutterPoint()` is kept only where explicitly
 * marked as a "gutter regression" check, proving the parent document's own
 * pre-existing path wasn't touched by this change.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");
const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function start(prefix: string): Promise<{ started: StartedServer; page: Page }> {
  const started = await startServerFor({ deckDir: demoDir, prefix });
  const page = await openApp(browser, started.server, { viewport: VIEWPORT });
  openPages.push(page);
  return { started, page };
}

async function stageTransform(page: Page): Promise<string> {
  return page.locator(".stage").evaluate((el) => getComputedStyle(el).transform);
}

function scaleOf(matrix: string): number {
  // matrix(a, b, c, d, tx, ty) — a is the scale (this shell's zoom carries no rotation/skew).
  const m = matrix.match(/matrix\(([^,]+),/);
  if (!m) throw new Error(`could not parse transform matrix: ${matrix}`);
  return parseFloat(m[1]);
}

/** Dead centre of the slide body itself — the area the iframe actually
 * renders, not the gutter. This is "the slide" in 05-INTERACTIONS.feature's
 * "on the slide, an element, or the blank area". */
async function slidePoint(page: Page): Promise<{ x: number; y: number }> {
  const stage = await page.locator(".stage").boundingBox();
  if (!stage) throw new Error(".stage has no boundingBox");
  return { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
}

/** The cursor of the document inside the iframe — this is what you see over
 * the slide body in hand mode, not `.canvas-area`'s cursor (that's the
 * parent document's own). */
async function slideCursor(page: Page): Promise<string> {
  return page
    .frameLocator("iframe.slide-frame")
    .locator("body")
    .evaluate(() => getComputedStyle(document.documentElement).cursor);
}

/** A point on the `.canvas-area` gutter (padding) background — outside the
 * `.stage`/iframe area. Used only for "gutter regression" assertions, see
 * the file header comment. */
async function gutterPoint(page: Page): Promise<{ x: number; y: number }> {
  const well = await page.locator(".canvas-area").boundingBox();
  if (!well) throw new Error("canvas-area has no boundingBox");
  return { x: well.x + 10, y: well.y + 10 };
}

/**
 * Zooms once with Ctrl/Cmd+wheel over `point` and verifies it's "anchored
 * on the cursor" (05-INTERACTIONS.feature's own wording): before zooming,
 * record the cursor's proportional position (u,v) relative to the `.stage`
 * rect; after zooming, the screen coordinate you get back from that same
 * proportional position must still land near the cursor's original position
 * (±3px). Asserting only that "scale increased" can't tell "anchored on the
 * cursor" apart from "anchored on the centre" — hard-coding the anchor to
 * the well's centre would also pass that assertion, so this is the check
 * that actually distinguishes the two.
 *
 * `deltaY` deliberately uses a small value (-20, about 5% zoom) rather than
 * a typical full wheel notch (-100 to -240): measurement shows `.stage`'s
 * CSS centring origin (top/left:50% relative to `.canvas-area`'s grid
 * track) differs from `wellRef.getBoundingClientRect()`'s geometric centre
 * by about 24px vertically in this test's viewport (1440x900) — horizontally
 * they align, 0px difference. This comes from `.canvas-area`'s grid layout
 * itself being asymmetric (the bottom reservation area), not from any code
 * this change touches (`stage-view.ts`/`Stage.tsx`'s `handleWheel` anchor
 * formula is untouched). This residual scales as `24px × (1 - zoomFactor)`,
 * growing with delta — using a real single-notch wheel delta would push the
 * residual past 20px, far outweighing measurement noise, but that's not a
 * regression from this change; it's an existing property of the existing
 * CSS layout. ±3px has enough margin at this smaller delta (the measured
 * residual is about 1.5px) while still failing on a genuinely broken
 * implementation that hard-codes the anchor to the well's centre (that kind
 * of bug produces an error on the order of the whole well-centre-to-`point`
 * distance, not 1-2px).
 */
async function zoomAtPointAndAssertAnchored(page: Page, point: { x: number; y: number }): Promise<void> {
  const rect0 = await page.locator(".stage").boundingBox();
  if (!rect0) throw new Error(".stage has no boundingBox (before zoom)");
  const u = (point.x - rect0.x) / rect0.width;
  const v = (point.y - rect0.y) / rect0.height;
  const before = scaleOf(await stageTransform(page));

  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -20);
  await page.keyboard.up("Control");

  await expect.poll(async () => scaleOf(await stageTransform(page))).toBeGreaterThan(before);
  const rect1 = await page.locator(".stage").boundingBox();
  if (!rect1) throw new Error(".stage has no boundingBox (after zoom)");
  expect(Math.abs(rect1.x + u * rect1.width - point.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(rect1.y + v * rect1.height - point.y)).toBeLessThanOrEqual(3);
}

it("wheel zoom: Ctrl/Cmd+wheel increases the stage's zoom factor, clamped to [25%,400%], anchored on the cursor (holds over both the slide body and the gutter)", async () => {
  const { started, page } = await start("stage-nav-wheel-zoom");
  try {
    const before = scaleOf(await stageTransform(page));
    expect(before).toBeCloseTo(1, 2);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    await zoomAtPointAndAssertAnchored(page, await slidePoint(page));
    const afterSlide = scaleOf(await stageTransform(page));
    expect(afterSlide).toBeGreaterThanOrEqual(0.25);
    expect(afterSlide).toBeLessThanOrEqual(4.0);
    expect(await page.locator(".dock-zoom-control").textContent()).not.toBe("100%");

    // Gutter regression: the parent document's own pre-existing wheel path wasn't touched by this change.
    await zoomAtPointAndAssertAnchored(page, await gutterPoint(page));
  } finally {
    await started.cleanup();
  }
});

it("wheel pan: an unmodified wheel only changes translate, leaving scale and the percentage text unchanged (over the slide body)", async () => {
  const { started, page } = await start("stage-nav-wheel-pan");
  try {
    const beforeTransform = await stageTransform(page);
    const beforeScale = scaleOf(beforeTransform);
    const beforePercent = await page.locator(".dock-zoom-control").textContent();

    const point = await slidePoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(120, 80);

    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);
    const afterScale = scaleOf(await stageTransform(page));
    expect(afterScale).toBeCloseTo(beforeScale, 5);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe(beforePercent);
  } finally {
    await started.cleanup();
  }
});

it("hand mode: clicking the hand toggles aria-pressed and both cursor spots, clears selection, and dragging over the slide body/an element/the gutter all pan", async () => {
  const { started, page } = await start("stage-nav-hand");
  try {
    // First select an element — the first thing entering hand mode should do is clear the current selection.
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    const selectionChip = page.locator(".status-selection-chip");
    await expect.poll(() => selectionChip.textContent()).not.toBe("");

    const handButton = page.locator(".dock-hand-button");
    expect(await handButton.getAttribute("aria-pressed")).toBe("false");

    await handButton.click();
    expect(await handButton.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    await expect.poll(() => slideCursor(page)).toBe("grab");
    await expect.poll(() => selectionChip.textContent()).toBe("");

    // Drag starting from dead centre of the slide body.
    let beforeTransform = await stageTransform(page);
    let point = await slidePoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);

    // Drag starting from an element — in hand mode this should not reselect it or start any other gesture, only pan.
    beforeTransform = await stageTransform(page);
    const titleBox = await page.frameLocator("iframe.slide-frame").locator("#el-title").boundingBox();
    if (!titleBox) throw new Error("#el-title has no boundingBox");
    point = { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 25, point.y + 15, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);
    await expect.poll(() => selectionChip.textContent()).toBe("");

    // Drag starting from the gutter — the parent document's own pre-existing path wasn't touched by this change.
    beforeTransform = await stageTransform(page);
    point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 20, point.y + 15, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);

    // Click again: neither cursor spot is grab any more.
    await handButton.click();
    expect(await handButton.getAttribute("aria-pressed")).toBe("false");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
    await expect.poll(() => slideCursor(page)).not.toBe("grab");
  } finally {
    await started.cleanup();
  }
});

it("temporary hand mode: with a selection's context bar overlapping the slide, holding Space and dragging from the bar's centre still pans (the context bar doesn't intercept pointer events in hand mode)", async () => {
  const { started, page } = await start("stage-nav-space-over-bar");
  try {
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    const bar = page.locator(".context-bar");
    await expect.poll(() => bar.isVisible()).toBe(true);
    const barBox = (await bar.boundingBox())!;

    await page.keyboard.down("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    const before = await stageTransform(page);
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(barBox.x + barBox.width / 2 + 30, barBox.y + barBox.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(before);
    await page.keyboard.up("Space");
  } finally {
    await started.cleanup();
  }
});

it("temporary hand mode: holding Space makes both cursor spots grab and lets you drag over the slide body, reverting on release; Space does nothing while an input field has focus", async () => {
  const { started, page } = await start("stage-nav-space");
  try {
    // (a) Focus is on the parent document (nothing on the slide has been clicked yet).
    await page.keyboard.down("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    await expect.poll(() => slideCursor(page)).toBe("grab");
    const beforeA = await stageTransform(page);
    const pointA = await slidePoint(page);
    await page.mouse.move(pointA.x, pointA.y);
    await page.mouse.down();
    await page.mouse.move(pointA.x + 40, pointA.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeA);
    await page.keyboard.up("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
    await expect.poll(() => slideCursor(page)).not.toBe("grab");

    // (b) Focus is inside the iframe — click a slide element first; the parent
    // document's window keydown listener never sees the following Space, so
    // it must be relayed through selection-runtime.js.
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await page.keyboard.down("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
    await expect.poll(() => slideCursor(page)).toBe("grab");
    const beforeB = await stageTransform(page);
    const pointB = await slidePoint(page);
    await page.mouse.move(pointB.x, pointB.y);
    await page.mouse.down();
    await page.mouse.move(pointB.x + 30, pointB.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeB);
    await page.keyboard.up("Space");
    await expect.poll(() => page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");

    // Pressing Space while the chat input is focused types a space character, and never enters hand mode.
    const chatInput = page.locator(".chat-input textarea");
    await chatInput.click();
    await chatInput.press("Space");
    expect(await chatInput.inputValue()).toBe(" ");
    expect(await page.locator(".canvas-area").evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
  } finally {
    await started.cleanup();
  }
});

it("zoom menu: opens centred directly above the dock, containing -/percentage/+/Fit/presets, the current value shown in red, and Fit returns to 100% centred", async () => {
  const { started, page } = await start("stage-nav-zoom-menu");
  try {
    await page.locator(".dock-zoom-control").click();
    const menu = page.locator(".zoom-menu");
    expect(await menu.count()).toBe(1);

    const dockBox = await page.locator(".dock").boundingBox();
    const menuBox = await menu.boundingBox();
    if (!dockBox || !menuBox) throw new Error("dock or zoom-menu has no boundingBox");
    const dockCenterX = dockBox.x + dockBox.width / 2;
    const menuCenterX = menuBox.x + menuBox.width / 2;
    expect(Math.abs(dockCenterX - menuCenterX)).toBeLessThanOrEqual(2);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(dockBox.y + 1);

    expect(await menu.locator(".zoom-menu-current").textContent()).toBe("100%");
    for (const label of ["50%", "75%", "100%", "150%", "200%", "400%"]) {
      expect(await menu.getByText(label, { exact: true }).count()).toBeGreaterThan(0);
    }
    const currentColor = await menu.locator(".zoom-menu-current").evaluate((el) => getComputedStyle(el).color);
    const brandRedRgb = await page.evaluate(() => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue("--brand-red").trim();
      const div = document.createElement("div");
      div.style.color = hex;
      document.body.appendChild(div);
      const rgb = getComputedStyle(div).color;
      div.remove();
      return rgb;
    });
    expect(currentColor).toBe(brandRedRgb);

    // Zoom in first, then click Fit: should return to 100% and centred (translate back to its initial value).
    await menu.locator('button[aria-label="Zoom in"]').click();
    await expect.poll(() => menu.locator(".zoom-menu-current").textContent()).not.toBe("100%");
    await menu.getByText("Fit", { exact: true }).click();
    await expect.poll(() => page.locator(".dock-zoom-control").textContent()).toBe("100%");
    const transform = await stageTransform(page);
    expect(scaleOf(transform)).toBeCloseTo(1, 5);
  } finally {
    await started.cleanup();
  }
});

it("middle-click drag: dragging over the gutter pans the canvas without changing the selection (06-KEYBOARD_AND_GESTURES.md's \"middle-click drag\")", async () => {
  const { started, page } = await start("stage-nav-middle-drag");
  try {
    // Select an element first; panning shouldn't touch it.
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    const selectionChip = page.locator(".status-selection-chip");
    await expect.poll(() => selectionChip.textContent()).not.toBe("");

    // Stage.tsx's `shouldPan = event.button === 1 || ...` is the parent
    // document's own mousedown handling, which only fires when the event
    // actually lands on the parent document (the gutter) — confirmed by
    // testing that a middle-click over the slide body (iframe content) has
    // no effect, because selection-runtime.js's pointerdown listener
    // returns early for any non-left-button event. This verifies the
    // gutter half of that behavior actually works.
    const beforeTransform = await stageTransform(page);
    const point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(point.x + 40, point.y + 30, { steps: 5 });
    await page.mouse.up({ button: "middle" });

    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);
    expect(await selectionChip.textContent()).not.toBe("");
  } finally {
    await started.cleanup();
  }
});

it("clicking the gutter around the slide clears the selection; dragging (panning) over that same gutter does not (06-KEYBOARD_AND_GESTURES.md's \"click blank to deselect\")", async () => {
  const { started, page } = await start("stage-nav-gutter-click-deselect");
  try {
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    const selectionChip = page.locator(".status-selection-chip");
    await expect.poll(() => selectionChip.textContent()).not.toBe("");
    const contextBar = page.locator(".context-bar");
    await expect.poll(() => contextBar.isVisible()).toBe(true);

    // First verify that "dragging" doesn't count as "clicking": dragging over
    // the gutter still only pans, without clearing the selection (the
    // existing "middle-click drag" scenario tests the middle button; this
    // verifies a left-click drag also doesn't clear).
    const beforeTransform = await stageTransform(page);
    let point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await stageTransform(page)).not.toBe(beforeTransform);
    expect(await selectionChip.textContent()).not.toBe("");

    // A "click" on the gutter (no displacement): selection box, handles, and context bar all clear.
    point = await gutterPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => selectionChip.textContent()).toBe("");
    await expect.poll(() => contextBar.count()).toBe(0);
  } finally {
    await started.cleanup();
  }
});

it("Cmd+0 / Cmd+= / Cmd+-: return to Fit, zoom in one step, zoom out one step, with the percentage text staying in sync", async () => {
  const { started, page } = await start("stage-nav-zoom-keys");
  try {
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    await page.keyboard.press("Meta+=");
    await expect.poll(() => page.locator(".dock-zoom-control").textContent()).not.toBe("100%");
    const afterIn = scaleOf(await stageTransform(page));
    expect(afterIn).toBeCloseTo(1.25, 5);

    await page.keyboard.press("Meta+-");
    await expect.poll(async () => scaleOf(await stageTransform(page))).toBeCloseTo(1, 5);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    // From a non-100% zoom value, Cmd+0 returns to Fit (100%, centred).
    await page.keyboard.press("Meta+=");
    await expect.poll(() => page.locator(".dock-zoom-control").textContent()).not.toBe("100%");
    await page.keyboard.press("Meta+0");
    await expect.poll(async () => scaleOf(await stageTransform(page))).toBeCloseTo(1, 5);
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");

    // With an input field focused, Cmd+0 does nothing (same guard as the existing keydown effects).
    const chatInput = page.locator(".chat-input textarea");
    await chatInput.click();
    await page.keyboard.press("Meta+=");
    expect(await page.locator(".dock-zoom-control").textContent()).toBe("100%");
  } finally {
    await started.cleanup();
  }
});
