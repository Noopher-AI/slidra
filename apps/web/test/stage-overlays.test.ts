import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHoverSolidifier, pointInsideRect, toLocalPoint, toLocalRect } from "../src/shell/stage-overlays/OverlayLayer.js";
import { SelectionOverlay } from "../src/shell/stage-overlays/SelectionOverlay.js";
import { ContextBar } from "../src/shell/stage-overlays/ContextBar.js";
import { TableCellMenu } from "../src/shell/stage-overlays/TableCellMenu.js";

/**
 * `SelectionOverlay`/`ContextBar`'s coordinate math (name label position,
 * context-bar below/above flip) and `OverlayLayer`'s parent-client-px ->
 * well-relative-px conversion had zero test coverage — everything under
 * `packages/web/src/shell/stage-overlays/` was reviewed by eye only. Same
 * `renderToStaticMarkup` convention `icons.test.ts` already uses for a small
 * presentational component: render with given props, inspect the resulting
 * markup string.
 */

describe("OverlayLayer's toLocalPoint / toLocalRect (parent-client px -> well-relative px)", () => {
  it("toLocalPoint subtracts the well's own offset", () => {
    expect(toLocalPoint({ x: 150, y: 220 }, { x: 100, y: 200 })).toEqual({ x: 50, y: 20 });
  });

  it("toLocalPoint is a no-op when the well sits at the document origin", () => {
    expect(toLocalPoint({ x: 150, y: 220 }, { x: 0, y: 0 })).toEqual({ x: 150, y: 220 });
  });

  it("toLocalRect subtracts the offset from x/y only — width/height pass through unchanged", () => {
    expect(toLocalRect({ x: 150, y: 220, width: 40, height: 30 }, { x: 100, y: 200 })).toEqual({
      x: 50,
      y: 20,
      width: 40,
      height: 30,
    });
  });
});

describe("pointInsideRect (F-17: hover hit-testing for the context bar)", () => {
  it("inside, on the boundary (inclusive), and one pixel outside the boundary", () => {
    const rect = { x: 100, y: 100, width: 50, height: 20 };
    expect(pointInsideRect({ x: 120, y: 110 }, rect)).toBe(true);
    // Following getBoundingClientRect's convention: the boundary itself counts as "inside".
    expect(pointInsideRect({ x: 100, y: 100 }, rect)).toBe(true);
    expect(pointInsideRect({ x: 150, y: 120 }, rect)).toBe(true);
    expect(pointInsideRect({ x: 99, y: 110 }, rect)).toBe(false);
    expect(pointInsideRect({ x: 151, y: 110 }, rect)).toBe(false);
  });
});

describe("createHoverSolidifier (F-17: dual-delay ghost/solid to prevent flicker)", () => {
  const SOLIDIFY_MS = 120;
  const GHOST_MS = 250;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("entering the rect: leaving before solidifyMs elapses (a quick scan) does not go solid; staying for the full solidifyMs does", () => {
    const onChange = vi.fn();
    const solidifier = createHoverSolidifier(onChange, SOLIDIFY_MS, GHOST_MS);

    // Quick scan: enters, leaves before the delay elapses.
    solidifier.update(true);
    vi.advanceTimersByTime(SOLIDIFY_MS - 10);
    solidifier.update(false);
    vi.advanceTimersByTime(SOLIDIFY_MS + GHOST_MS);
    expect(onChange).not.toHaveBeenCalled();

    // Real stay: enters and holds for the full delay.
    solidifier.update(true);
    vi.advanceTimersByTime(SOLIDIFY_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("leaving the rect: returning before ghostMs elapses (border jitter) stays solid without flicker; staying away for the full ghostMs reverts to ghost; reset() clears immediately and cancels any pending timer", () => {
    const onChange = vi.fn();
    const solidifier = createHoverSolidifier(onChange, SOLIDIFY_MS, GHOST_MS);
    solidifier.update(true);
    vi.advanceTimersByTime(SOLIDIFY_MS);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(true);
    onChange.mockClear();

    // Border jitter: leaves, comes back before GHOST_MS elapses.
    solidifier.update(false);
    vi.advanceTimersByTime(GHOST_MS - 10);
    solidifier.update(true);
    vi.advanceTimersByTime(GHOST_MS);
    expect(onChange).not.toHaveBeenCalled();

    // Leaves for real, this time for the full GHOST_MS.
    solidifier.update(false);
    vi.advanceTimersByTime(GHOST_MS);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(false);
    onChange.mockClear();

    // reset(): back to solid, then reset() must both fire ghost immediately
    // AND cancel whatever pending timer it interrupted.
    solidifier.update(true);
    vi.advanceTimersByTime(SOLIDIFY_MS);
    onChange.mockClear();
    solidifier.reset();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(false);
    onChange.mockClear();
    vi.advanceTimersByTime(GHOST_MS + SOLIDIFY_MS);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SelectionOverlay: name / group / drill-in path label (05-INTERACTIONS.feature 'Selection > Single select')", () => {
  it("no selection (union/label both null): renders nothing, no .selection-label", () => {
    const markup = renderToStaticMarkup(createElement(SelectionOverlay, { union: null, label: null }));
    expect(markup).not.toContain("selection-label");
  });

  it("single element selected: label shows only the element name (no › when there's no drill-in path)", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionOverlay, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        label: { text: "方塊 A", path: [] },
      }),
    );
    expect(markup).toContain(">方塊 A<");
    expect(markup).not.toContain("›");
  });

  it("drilled into a group: label follows the ancestor chain from outermost to innermost, joined by '›' (F9's 'Group 2 › Group 1' shape)", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionOverlay, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        label: { text: "群組子元素", path: ["群組 2", "群組 1"] },
      }),
    );
    expect(markup).toContain(">群組 2 › 群組 1 › 群組子元素<");
  });

  it("label is positioned at the selection box's top-left corner, offset up 22px (left=union.x, top=union.y-22)", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionOverlay, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        label: { text: "方塊 A", path: [] },
      }),
    );
    expect(markup).toContain("left:100px");
    expect(markup).toContain("top:78px");
  });
});

describe("ContextBar: positioning and above/below flip (05-INTERACTIONS.feature 'Selection > Single select', 'context bar appears directly below the selection box, flips above when there's not enough room')", () => {
  it("no selection (union is null): renders nothing, no .context-bar", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: null,
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onEditStyle: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).not.toContain("context-bar\"");
  });

  it("enough room below: context bar appears directly below the selection box (top = union.y + union.height + 13)", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onEditStyle: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    // union bottom edge = 200; +13 gap = 213.
    expect(markup).toContain("left:100px");
    expect(markup).toContain("top:213px");
  });

  it("not enough room below (selection box close to the Dock reserved zone at the bottom of the canvas): flips above (top = union.y - 13 - 36)", () => {
    // Well is 720px tall, the bottom 76px belong to the Dock (DOCK_RESERVE);
    // a selection whose bottom edge sits at 620 leaves 620+13+36 = 669 > 644.
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 570, width: 160, height: 50 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onEditStyle: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    // 570 - 13 - 36 = 521.
    expect(markup).toContain("top:521px");
  });

  it("while dragging: the context bar does not render", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: true,
        hasAnimation: false,
        onEditAnimation: () => {},
        onEditStyle: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).not.toContain("context-bar\"");
  });

  it("glass container: Comment to AI | Edit style | four layer-order items (icons) | Copy/Cut/Paste (icons) | Duplicate | Delete", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onEditStyle: () => {},
        onComment: () => {},
        onOrder: () => {},
        onCopy: () => {},
        onCut: () => {},
        onPaste: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).toContain('role="toolbar"');
    const titles = [...markup.matchAll(/<button[^>]*title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "Comment to AI",
      "Edit style",
      "Bring to front",
      "Bring forward",
      "Send backward",
      "Send to back",
      "Copy",
      "Cut",
      "Paste",
      "Duplicate",
      "Delete",
    ]);
    // +3 icon-only buttons (Copy/Cut/Paste), same class as the four Order buttons — 4 + 3 = 7.
    expect(markup.match(/context-bar-item-icon/g)).toHaveLength(7);
    expect(markup.match(/context-bar-divider/g)).toHaveLength(4);
    expect(markup).toContain("context-bar-item-danger");
    // hasAnimation: false — no Edit animation button at all (not merely disabled/hidden).
    expect(markup).not.toContain("Edit animation");
    // Copy/Cut/Paste each render their OWN icon — three distinct
    // markup strings, not one icon copy-pasted three times (merged in from a
    // deleted test that asserted the same intent via internal SVG details —
    // circle counts, stroke widths — instead of this public-shape check).
    const iconMarkups = ["Copy", "Cut", "Paste"].map(
      (title) => new RegExp(`<button[^>]*title="${title}"[^>]*>(.*?)<\\/button>`).exec(markup)?.[1] ?? "",
    );
    expect(new Set(iconMarkups).size).toBe(3);
  });

  // 07-DISCUSSION_LOG.md: no Edit animation button when there's no animation
  it("when hasAnimation: true, an Edit animation (spark icon) button renders to the right of Edit style", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: true,
        onEditAnimation: () => {},
        onComment: () => {},
        onEditStyle: () => {},
        onOrder: () => {},
        onCopy: () => {},
        onCut: () => {},
        onPaste: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    const titles = [...markup.matchAll(/<button[^>]*title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "Comment to AI",
      "Edit style",
      "Edit animation",
      "Bring to front",
      "Bring forward",
      "Send backward",
      "Send to back",
      "Copy",
      "Cut",
      "Paste",
      "Duplicate",
      "Delete",
    ]);
  });

  it("exactly at the flip threshold: flush with the top edge of the Dock reserved zone still counts as 'fits', so it does not flip", () => {
    // union.y + union.height + GAP + BAR_HEIGHT === bounds.height - DOCK_RESERVE exactly.
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 0, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 325 }, // 100+100+13+36+76 = 325
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onEditStyle: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).toContain("top:213px"); // below, not flipped
  });
});

describe("TableCellMenu (plan §4.5)", () => {
  it("always shows Edit/Bold/insert-row/insert-column/delete-row/delete-column/Clear; hides Merge cells when canMerge=false", () => {
    const markup = renderToStaticMarkup(
      createElement(TableCellMenu, {
        menuRef: { current: null },
        x: 10,
        y: 20,
        canMerge: false,
        canUnmerge: false,
        onEdit: () => {},
        onBold: () => {},
        onInsertRowAbove: () => {},
        onInsertRowBelow: () => {},
        onInsertColLeft: () => {},
        onInsertColRight: () => {},
        onMerge: () => {},
        onUnmerge: () => {},
        onDeleteRow: () => {},
        onDeleteCol: () => {},
        onClear: () => {},
      }),
    );
    expect(markup).toContain(">Edit<");
    expect(markup).toContain(">Bold<");
    expect(markup).toContain(">Insert row above<");
    expect(markup).toContain(">Insert row below<");
    expect(markup).toContain(">Insert column left<");
    expect(markup).toContain(">Insert column right<");
    expect(markup).toContain(">Delete row<");
    expect(markup).toContain(">Delete column<");
    expect(markup).toContain(">Clear<");
    expect(markup).not.toContain("Merge cells");
    expect(markup).not.toContain(">Unmerge<");
  });

  it("shows Merge cells when canMerge=true, and Unmerge when canUnmerge=true", () => {
    const markup = renderToStaticMarkup(
      createElement(TableCellMenu, {
        menuRef: { current: null },
        x: 0,
        y: 0,
        canMerge: true,
        canUnmerge: true,
        onEdit: () => {},
        onBold: () => {},
        onInsertRowAbove: () => {},
        onInsertRowBelow: () => {},
        onInsertColLeft: () => {},
        onInsertColRight: () => {},
        onMerge: () => {},
        onUnmerge: () => {},
        onDeleteRow: () => {},
        onDeleteCol: () => {},
        onClear: () => {},
      }),
    );
    expect(markup).toContain("Merge cells");
    expect(markup).toContain(">Unmerge<");
  });
});

/**
 * Two-tier layering: the `z-index` convergence and `!important` pass-through
 * rule are both constraints on the *source text* (a browser's computed style
 * can't verify "how many z values are in the file" or "whether `!important`
 * is written"), so this uses the same `node:fs` + regex approach as
 * `design-contract.test.ts` rather than mounting a jsdom stylesheet.
 */
describe("stage-overlays.css: text-contract for two-tier z-index and pointer-events", () => {
  const cssPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "styles",
    "stage-overlays.css",
  );
  const css = readFileSync(cssPath, "utf-8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  it("AC2: exactly three z-index declarations, belonging to .stage-geometry(1) / .stage-widgets(2) / .comment-composer(5)", () => {
    const declarations = [...withoutComments.matchAll(/([.\w-]+)\s*\{[^}]*z-index:\s*(\d+)/g)].map((m) => ({
      selector: m[1],
      value: m[2],
    }));
    expect(declarations).toEqual([
      { selector: ".stage-geometry", value: "1" },
      { selector: ".stage-widgets", value: "2" },
      { selector: ".comment-composer", value: "5" },
    ]);
  });

  it("AC3: the geometry layer's forced pass-through rule exists verbatim — `.stage-geometry, .stage-geometry * { pointer-events: none !important }`", () => {
    const normalized = withoutComments.replace(/\s+/g, "");
    expect(normalized).toContain(".stage-geometry,.stage-geometry*{pointer-events:none!important;}");
  });

  // F-17: the context bar passes through pointer events by default (ghost),
  // and only becomes clickable once `.is-solid` is applied — specificity 0,3,0
  // overrides `.stage-widgets > .context-bar`'s 0,2,0. Both rules must exist
  // verbatim for "the context bar handles hover itself" to actually take
  // effect, not just look right.
  it("F-17: the context bar defaults to pointer-events:none, only `.is-solid` switches it back to auto", () => {
    const normalized = withoutComments.replace(/\s+/g, "");
    expect(normalized).toContain(".stage-widgets>.context-bar{pointer-events:none;}");
    expect(normalized).toContain(".stage-widgets>.context-bar.is-solid{pointer-events:auto;}");
  });
});
