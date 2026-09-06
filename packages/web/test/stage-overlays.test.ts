import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { toLocalPoint, toLocalRect } from "../src/shell/stage-overlays/OverlayLayer.js";
import { SelectionOverlay } from "../src/shell/stage-overlays/SelectionOverlay.js";
import { ContextBar } from "../src/shell/stage-overlays/ContextBar.js";

/**
 * NOOP-91 round-2 FAIL #4: `SelectionOverlay`/`ContextBar`'s coordinate math
 * (name label position, context-bar below/above flip) and `OverlayLayer`'s
 * parent-client-px -> well-relative-px conversion had zero test coverage —
 * everything under `packages/web/src/shell/stage-overlays/` was reviewed by
 * eye only. Same `renderToStaticMarkup` convention `icons.test.ts` already
 * uses for a small presentational component: render with given props,
 * inspect the resulting markup string.
 */

describe("OverlayLayer の toLocalPoint／toLocalRect（parent-client px -> well-relative px）", () => {
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

describe("SelectionOverlay：名稱／群組／鑽入路徑標籤（05-INTERACTIONS.feature「選取 › 單選」）", () => {
  it("沒有選取（union/label 皆 null）：渲染空容器，不含 .selection-label", () => {
    const markup = renderToStaticMarkup(createElement(SelectionOverlay, { union: null, label: null }));
    expect(markup).not.toContain("selection-label");
  });

  it("單選一個元素：標籤只顯示元素名稱（沒有鑽入路徑時不加 ›）", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionOverlay, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        label: { text: "方塊 A", path: [] },
      }),
    );
    expect(markup).toContain(">方塊 A<");
    expect(markup).not.toContain("›");
  });

  it("鑽入群組：標籤依祖先鏈由外到內、以「›」串接（F9「Group 2 › Group 1」的形狀）", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionOverlay, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        label: { text: "群組子元素", path: ["群組 2", "群組 1"] },
      }),
    );
    expect(markup).toContain(">群組 2 › 群組 1 › 群組子元素<");
  });

  it("標籤定位在選取框左上角、往上偏移 22px（left=union.x, top=union.y-22）", () => {
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

describe("ContextBar：情境列定位與上下翻轉（05-INTERACTIONS.feature「選取 › 單選」「情境列出現在選取框正下方（空間不足則翻到上方）」）", () => {
  it("沒有選取（union 為 null）：渲染空容器，不含 .context-bar", () => {
    const markup = renderToStaticMarkup(createElement(ContextBar, { union: null, bounds: { height: 720 }, onDelete: () => {} }));
    expect(markup).not.toContain("context-bar\"");
  });

  it("下方空間足夠：情境列出現在選取框正下方（top = union.y + union.height + 8）", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { height: 720 },
        onDelete: () => {},
      }),
    );
    // union bottom edge = 200; +8 gap = 208.
    expect(markup).toContain("left:100px");
    expect(markup).toContain("top:208px");
  });

  it("下方空間不足（選取框貼近畫布底部）：翻到上方（top = union.y - 8 - 40）", () => {
    // Well is only 720px tall; a selection whose bottom edge sits at 700
    // leaves only 20px below it — less than GAP(8) + BAR_HEIGHT(40) = 48.
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 650, width: 160, height: 50 },
        bounds: { height: 720 },
        onDelete: () => {},
      }),
    );
    // 650 - 8 - 40 = 602.
    expect(markup).toContain("top:602px");
  });

  it("玻璃容器：Delete 帶 trash 圖示，並為 Comment to AI／Edit 兩組預留插槽與分隔線", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { height: 720 },
        onDelete: () => {},
      }),
    );
    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain("context-bar-slot-comment");
    expect(markup).toContain("context-bar-slot-edit");
    expect(markup.match(/context-bar-divider/g)).toHaveLength(2);
    expect(markup).toContain("context-bar-item-danger");
    expect(markup).toContain("<svg"); // the trash icon
    expect(markup).toContain("Delete");
  });

  it("剛好卡在翻轉門檻上：貼齊 bounds.height 仍算「放得下」，不翻轉", () => {
    // union.y + union.height + GAP + BAR_HEIGHT === bounds.height exactly.
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 0, y: 100, width: 160, height: 100 },
        bounds: { height: 248 }, // 100+100+8+40 = 248
        onDelete: () => {},
      }),
    );
    expect(markup).toContain("top:208px"); // below, not flipped
  });
});
