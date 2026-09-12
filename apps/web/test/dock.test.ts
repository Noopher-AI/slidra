// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanvasController, CanvasSelection } from "../src/canvas.js";
import type { SlideElement } from "../src/slide-dom.js";
import { computeGroupButtonState, Dock, DockToast, groupToastText, type DockProps } from "../src/shell/dock/Dock.js";
import { ShapeMenu } from "../src/shell/dock/menus/ShapeMenu.js";

/**
 * Dock's public boundary for button state and toast text is props/pure-function
 * output (the convention already used by animate-panel.test.ts), not hook call
 * counts or whether a mock got called. `controller`/`selection.elements` only
 * need the fields Dock actually reads; the rest is filled in with a type
 * assertion — these tests never fire any interaction event, and
 * renderToStaticMarkup never calls them either.
 */

function element(kind: SlideElement["kind"]): SlideElement {
  return { kind } as unknown as SlideElement;
}

function selection(elements: (SlideElement | null)[]): CanvasSelection {
  return {
    ids: elements.map((_, i) => `el-${i}`),
    names: elements.map(() => null),
    groupPath: [],
    elements,
  };
}

const controllerStub = {} as CanvasController;

function noop(): void {
  /* renderToStaticMarkup never fires handlers — these exist only to satisfy prop types. */
}

function dockProps(overrides: Partial<DockProps> = {}): DockProps {
  return {
    zoomPan: { zoom: 1, pan: { x: 0, y: 0 } },
    onZoomPanChange: noop,
    hand: { hand: false, spaceHeld: false },
    onToggleHand: noop,
    selection: selection([]),
    controller: controllerStub,
    slidePath: "slides/001.svg",
    onAnimationAdded: noop,
    canvasSize: { width: 1280, height: 720 },
    pageStyle: null,
    ...overrides,
  };
}

function markupFor(overrides: Partial<DockProps> = {}): string {
  return renderToStaticMarkup(createElement(Dock, dockProps(overrides)));
}

/** Every `.dock-command`'s aria-label → whether it rendered `disabled`. */
function commandDisabledMap(markup: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const match of markup.matchAll(/<button[^>]*class="dock-command"[^>]*>/g)) {
    const tag = match[0];
    const label = /aria-label="([^"]+)"/.exec(tag)?.[1];
    if (label) result[label] = / disabled(?:="")?[ >]/.test(tag);
  }
  return result;
}

describe("computeGroupButtonState (disabled states + single-button toggle behavior)", () => {
  it("no selection: label Group, disabled", () => {
    expect(computeGroupButtonState(selection([]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: true,
    });
  });

  it("one non-group element selected: label Group, disabled", () => {
    expect(computeGroupButtonState(selection([element("rect")]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: true,
    });
  });

  it("one group selected: label Ungroup, enabled", () => {
    expect(computeGroupButtonState(selection([element("group")]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Ungroup",
      disabled: false,
    });
  });

  it("two elements selected (a nested group + a plain element): label Group, enabled", () => {
    expect(computeGroupButtonState(selection([element("group"), element("rect")]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: false,
    });
  });

  it("slidePath is null: disabled even with a valid selection", () => {
    expect(computeGroupButtonState(selection([element("group")]), controllerStub, null, false)).toEqual({
      label: "Ungroup",
      disabled: true,
    });
  });

  it("controller is null: disabled", () => {
    expect(computeGroupButtonState(selection([element("group")]), null, "slides/001.svg", false)).toEqual({
      label: "Ungroup",
      disabled: true,
    });
  });

  it("selection.elements[0] is null (a reload racing with selection): treated as non-group, must not be mistaken for a group", () => {
    expect(computeGroupButtonState(selection([null]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: true,
    });
  });

  it("while pending: disabled even with a valid selection (prevents a double-click firing the command twice)", () => {
    expect(computeGroupButtonState(selection([element("group")]), controllerStub, "slides/001.svg", true)).toEqual({
      label: "Ungroup",
      disabled: true,
    });
  });
});

describe("Dock selection state → the disabled set for every dock button (covers a case previously in e2e/selection.test.ts, now removed there)", () => {
  it("no selection: only Animate/Arrange/Group are disabled, the Insert group and Zoom are unaffected", () => {
    const disabled = commandDisabledMap(markupFor({ selection: selection([]) }));
    expect(disabled).toEqual({
      Text: false,
      Shape: false,
      Image: false,
      Video: false,
      Audio: false,
      Table: false,
      Chart: false,
      Animate: true,
      Arrange: true,
      Group: true,
    });
  });

  it("one non-group element selected: Animate/Arrange become enabled, Group stays disabled, everything else unaffected", () => {
    const disabled = commandDisabledMap(markupFor({ selection: selection([element("rect")]) }));
    expect(disabled).toEqual({
      Text: false,
      Shape: false,
      Image: false,
      Video: false,
      Audio: false,
      Table: false,
      Chart: false,
      Animate: false,
      Arrange: false,
      Group: true,
    });
  });

  it("two elements selected: Group also becomes enabled, no button remains disabled", () => {
    const disabled = commandDisabledMap(markupFor({ selection: selection([element("rect"), element("rect")]) }));
    expect(Object.values(disabled).every((v) => v === false)).toBe(true);
  });

  it("one group selected: label is Ungroup and enabled", () => {
    const markup = markupFor({ selection: selection([element("group")]) });
    expect(markup).toContain('aria-label="Ungroup"');
    expect(commandDisabledMap(markup).Ungroup).toBe(false);
  });
});

describe("groupToastText (wording copied verbatim from the prototype, not translated or reworded)", () => {
  it("grouping, with animations removed", () => {
    expect(groupToastText("group", 2, 1)).toBe("Grouped 2 elements · their animations were removed");
  });
  it("grouping, no animations removed", () => {
    expect(groupToastText("group", 3, 0)).toBe("Grouped 3 elements");
  });
  it("ungrouping, with animation removed", () => {
    expect(groupToastText("ungroup", 1, 1)).toBe("Ungrouped · the group animation was removed");
  });
  it("ungrouping, no animation removed", () => {
    expect(groupToastText("ungroup", 1, 0)).toBe("Ungrouped");
  });
});

describe("DockToast markup", () => {
  it("role=status, class is dock-toast", () => {
    const markup = renderToStaticMarkup(createElement(DockToast, { text: "Grouped 2 elements" }));
    expect(markup).toBe('<div role="status" class="dock-toast">Grouped 2 elements</div>');
  });
});

describe("ShapeMenu (the Rectangle/Ellipse/Line items and their disabled conditions)", () => {
  const controllerStubShape = {} as CanvasController;

  function shapeMenuMarkup(overrides: Partial<Parameters<typeof ShapeMenu>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(ShapeMenu, {
        onClose: noop,
        controller: controllerStubShape,
        canvasSize: { width: 1280, height: 720 },
        slidePath: "slides/001.svg",
        pageStyle: null,
        ...overrides,
      }),
    );
  }

  it("renders three items: Rectangle/Ellipse/Line", () => {
    const markup = shapeMenuMarkup();
    expect(markup).toContain(">Rectangle<");
    expect(markup).toContain(">Ellipse<");
    expect(markup).toContain(">Line<");
  });

  it("when controller is null, all three items are disabled", () => {
    const markup = shapeMenuMarkup({ controller: null });
    expect((markup.match(/ disabled(?:="")?[ >]/g) ?? []).length).toBe(3);
  });

  it("canvasSize or slidePath being null likewise disables them; with all three present, they're clickable", () => {
    expect((shapeMenuMarkup({ canvasSize: null }).match(/ disabled(?:="")?[ >]/g) ?? []).length).toBe(3);
    expect((shapeMenuMarkup({ slidePath: null }).match(/ disabled(?:="")?[ >]/g) ?? []).length).toBe(3);
    expect(shapeMenuMarkup().match(/ disabled(?:="")?[ >]/g)).toBeNull();
  });
});
