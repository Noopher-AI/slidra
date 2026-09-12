import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanvasController, CanvasSelection } from "../src/canvas.js";
import type { SlideElement } from "../src/slide-dom.js";
import { computeGroupButtonState, Dock, DockToast, groupToastText, type DockProps } from "../src/shell/dock/Dock.js";
import { ShapeMenu } from "../src/shell/dock/menus/ShapeMenu.js";

/**
 * [E2.T15]/#205 §6.3: Dock 的按鈕狀態與 toast 文字的公開邊界是 props/純函式
 * 輸出（animate-panel.test.ts 的慣例），不是 hook 呼叫次數或 mock 有沒有被
 * 叫到。`controller`/`selection.elements` 只需要 Dock 實際讀到的欄位，其餘
 * 用型別斷言補完——這幾個測試從不觸發任何互動事件，renderToStaticMarkup
 * 也不會呼叫它們。
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

describe("computeGroupButtonState（05-INTERACTIONS.feature「停用態」＋ D5 單一按鈕切換）", () => {
  it("沒有選取：Group、disabled", () => {
    expect(computeGroupButtonState(selection([]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: true,
    });
  });

  it("選了 1 個非群組元素：Group、disabled", () => {
    expect(computeGroupButtonState(selection([element("rect")]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: true,
    });
  });

  it("選了 1 個群組：Ungroup、enabled", () => {
    expect(computeGroupButtonState(selection([element("group")]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Ungroup",
      disabled: false,
    });
  });

  it("選了 2 個元素（含巢狀「群組＋元素」）：Group、enabled", () => {
    expect(computeGroupButtonState(selection([element("group"), element("rect")]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: false,
    });
  });

  it("slidePath 為 null：即使選取合法也 disabled", () => {
    expect(computeGroupButtonState(selection([element("group")]), controllerStub, null, false)).toEqual({
      label: "Ungroup",
      disabled: true,
    });
  });

  it("controller 為 null：disabled", () => {
    expect(computeGroupButtonState(selection([element("group")]), null, "slides/001.svg", false)).toEqual({
      label: "Ungroup",
      disabled: true,
    });
  });

  it("selection.elements[0] 為 null（reload 與選取賽跑）：視為非群組，不得當成群組", () => {
    expect(computeGroupButtonState(selection([null]), controllerStub, "slides/001.svg", false)).toEqual({
      label: "Group",
      disabled: true,
    });
  });

  it("pending 中：即使選取合法也 disabled（避免連點兩次送出兩次命令）", () => {
    expect(computeGroupButtonState(selection([element("group")]), controllerStub, "slides/001.svg", true)).toEqual({
      label: "Ungroup",
      disabled: true,
    });
  });
});

describe("Dock 選取狀態 → 每顆 dock 按鈕的 disabled 集合（接手 e2e/selection.test.ts 被刪掉的那條）", () => {
  it("沒有選取：只有 Animate／Arrange／Group 三顆 disabled，Insert 群組與 Zoom 不受影響", () => {
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

  it("選了 1 個非群組元素：Animate／Arrange 變 enabled，Group 仍 disabled，其餘不受影響", () => {
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

  it("選了 2 個元素：Group 也變 enabled，沒有任何按鈕維持 disabled", () => {
    const disabled = commandDisabledMap(markupFor({ selection: selection([element("rect"), element("rect")]) }));
    expect(Object.values(disabled).every((v) => v === false)).toBe(true);
  });

  it("選了 1 個群組：label 是 Ungroup 且 enabled", () => {
    const markup = markupFor({ selection: selection([element("group")]) });
    expect(markup).toContain('aria-label="Ungroup"');
    expect(commandDisabledMap(markup).Ungroup).toBe(false);
  });
});

describe("groupToastText（D3/D4：文案照抄原型，不翻譯不改寫）", () => {
  it("成組、有移除動畫", () => {
    expect(groupToastText("group", 2, 1)).toBe("Grouped 2 elements · their animations were removed");
  });
  it("成組、沒有移除動畫", () => {
    expect(groupToastText("group", 3, 0)).toBe("Grouped 3 elements");
  });
  it("解組、有移除動畫", () => {
    expect(groupToastText("ungroup", 1, 1)).toBe("Ungrouped · the group animation was removed");
  });
  it("解組、沒有移除動畫", () => {
    expect(groupToastText("ungroup", 1, 0)).toBe("Ungrouped");
  });
});

describe("DockToast 標記", () => {
  it("role=status、class 是 dock-toast", () => {
    const markup = renderToStaticMarkup(createElement(DockToast, { text: "Grouped 2 elements" }));
    expect(markup).toBe('<div role="status" class="dock-toast">Grouped 2 elements</div>');
  });
});

describe("ShapeMenu（[E2.T17] plan §4.1：Rectangle/Ellipse/Line 三個項目與 disabled 條件）", () => {
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

  it("渲染三個項目：Rectangle/Ellipse/Line", () => {
    const markup = shapeMenuMarkup();
    expect(markup).toContain(">Rectangle<");
    expect(markup).toContain(">Ellipse<");
    expect(markup).toContain(">Line<");
  });

  it("controller 為 null 時三個項目都 disabled", () => {
    const markup = shapeMenuMarkup({ controller: null });
    expect((markup.match(/ disabled(?:="")?[ >]/g) ?? []).length).toBe(3);
  });

  it("canvasSize 或 slidePath 為 null 時同樣 disabled；三者都齊全時可按", () => {
    expect((shapeMenuMarkup({ canvasSize: null }).match(/ disabled(?:="")?[ >]/g) ?? []).length).toBe(3);
    expect((shapeMenuMarkup({ slidePath: null }).match(/ disabled(?:="")?[ >]/g) ?? []).length).toBe(3);
    expect(shapeMenuMarkup().match(/ disabled(?:="")?[ >]/g)).toBeNull();
  });
});
