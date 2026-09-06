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
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: null,
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).not.toContain("context-bar\"");
  });

  it("下方空間足夠：情境列出現在選取框正下方（top = union.y + union.height + 13）", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
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

  it("下方空間不足（選取框貼近畫布底部的 Dock 保留區）：翻到上方（top = union.y - 13 - 36）", () => {
    // Well is 720px tall, the bottom 76px belong to the Dock (DOCK_RESERVE);
    // a selection whose bottom edge sits at 620 leaves 620+13+36 = 669 > 644.
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 570, width: 160, height: 50 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    // 570 - 13 - 36 = 521.
    expect(markup).toContain("top:521px");
  });

  it("拖曳中（dragging）：不渲染情境列，只留空容器", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: true,
        hasAnimation: false,
        onEditAnimation: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).not.toContain("context-bar\"");
  });

  it("玻璃容器：Comment to AI ｜ Edit style ｜ 前後層四項（圖示） ｜ Duplicate ｜ Delete", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).toContain('role="toolbar"');
    const titles = [...markup.matchAll(/<button[^>]*title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual(["Comment to AI", "Edit style", "Bring to front", "Bring forward", "Send backward", "Send to back", "Duplicate", "Delete"]);
    expect(markup.match(/context-bar-item-icon/g)).toHaveLength(4);
    expect(markup.match(/context-bar-divider/g)).toHaveLength(3);
    expect(markup).toContain("context-bar-item-danger");
    // [E2.T7]: hasAnimation: false — no Edit animation button at all (not merely disabled/hidden).
    expect(markup).not.toContain("Edit animation");
  });

  // [E2.T7]/07-DISCUSSION_LOG.md「無動畫時不顯示 Edit animation」
  it("hasAnimation: true 時，Edit style 右側渲染 Edit animation（spark 圖示）", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 100, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 720 },
        dragging: false,
        hasAnimation: true,
        onEditAnimation: () => {},
        onOrder: () => {},
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
      "Duplicate",
      "Delete",
    ]);
  });

  it("剛好卡在翻轉門檻上：貼齊 Dock 保留區上緣仍算「放得下」，不翻轉", () => {
    // union.y + union.height + GAP + BAR_HEIGHT === bounds.height - DOCK_RESERVE exactly.
    const markup = renderToStaticMarkup(
      createElement(ContextBar, {
        union: { x: 0, y: 100, width: 160, height: 100 },
        bounds: { width: 1280, height: 325 }, // 100+100+13+36+76 = 325
        dragging: false,
        hasAnimation: false,
        onEditAnimation: () => {},
        onComment: () => {},
        onOrder: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
      }),
    );
    expect(markup).toContain("top:213px"); // below, not flipped
  });
});
