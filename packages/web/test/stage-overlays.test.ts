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

describe("pointInsideRect（[E5.T7]/F-17：情境列的 hover 命中測試）", () => {
  it("內部、邊界（含）、邊界外一像素", () => {
    const rect = { x: 100, y: 100, width: 50, height: 20 };
    expect(pointInsideRect({ x: 120, y: 110 }, rect)).toBe(true);
    // getBoundingClientRect 的慣例：邊界本身算「在裡面」。
    expect(pointInsideRect({ x: 100, y: 100 }, rect)).toBe(true);
    expect(pointInsideRect({ x: 150, y: 120 }, rect)).toBe(true);
    expect(pointInsideRect({ x: 99, y: 110 }, rect)).toBe(false);
    expect(pointInsideRect({ x: 151, y: 110 }, rect)).toBe(false);
  });
});

describe("createHoverSolidifier（[E5.T7]/F-17 決定 8：ghost/solid 雙延遲防閃爍）", () => {
  const SOLIDIFY_MS = 120;
  const GHOST_MS = 250;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("進入 rect：未滿 solidifyMs 就離開（快速掃過）不轉 solid；停留滿 solidifyMs 才轉 solid", () => {
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

  it("離開 rect：未滿 ghostMs 就回來（邊界抖動）維持 solid、不閃；停留滿 ghostMs 才轉回 ghost；reset() 立即清空並清掉待處理計時器", () => {
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

describe("SelectionOverlay：名稱／群組／鑽入路徑標籤（05-INTERACTIONS.feature「選取 › 單選」）", () => {
  it("沒有選取（union/label 皆 null）：不渲染，不含 .selection-label", () => {
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
  it("沒有選取（union 為 null）：不渲染，不含 .context-bar", () => {
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

  it("下方空間足夠：情境列出現在選取框正下方（top = union.y + union.height + 13）", () => {
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

  it("拖曳中（dragging）：不渲染情境列", () => {
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

  it("玻璃容器：Comment to AI ｜ Edit style ｜ 前後層四項（圖示） ｜ Copy／Cut／Paste（圖示） ｜ Duplicate ｜ Delete", () => {
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
    // [E2.T18]: +3 icon-only buttons (Copy/Cut/Paste), same class as the four Order buttons — 4 + 3 = 7.
    expect(markup.match(/context-bar-item-icon/g)).toHaveLength(7);
    expect(markup.match(/context-bar-divider/g)).toHaveLength(4);
    expect(markup).toContain("context-bar-item-danger");
    // [E2.T7]: hasAnimation: false — no Edit animation button at all (not merely disabled/hidden).
    expect(markup).not.toContain("Edit animation");
    // [E2.T18] A9: Copy/Cut/Paste each render their OWN icon — three distinct
    // markup strings, not one icon copy-pasted three times (merged in from a
    // deleted test that asserted the same intent via internal SVG details —
    // circle counts, stroke widths — instead of this public-shape check).
    const iconMarkups = ["Copy", "Cut", "Paste"].map(
      (title) => new RegExp(`<button[^>]*title="${title}"[^>]*>(.*?)<\\/button>`).exec(markup)?.[1] ?? "",
    );
    expect(new Set(iconMarkups).size).toBe(3);
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

  it("剛好卡在翻轉門檻上：貼齊 Dock 保留區上緣仍算「放得下」，不翻轉", () => {
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

describe("TableCellMenu（E2.T14, plan §4.5）", () => {
  it("永遠顯示 Edit/Bold/插列插欄/刪列刪欄/Clear；canMerge=false 時不顯示 Merge cells", () => {
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

  it("canMerge=true 時顯示 Merge cells，canUnmerge=true 時顯示 Unmerge", () => {
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
 * [E5.T3] 兩層化：`z-index` 收斂與 `!important` 穿透規則都是對*原始碼文字*
 * 的約束（瀏覽器 computed style 驗不出「檔案裡有幾個 z 值」「有沒有寫
 * `!important`」），跟 `design-contract.test.ts` 同一套 `node:fs` + regex 做
 * 法，不掛 jsdom 樣式表。
 */
describe("stage-overlays.css：兩層化的 z-index 與 pointer-events 文字契約", () => {
  const cssPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "styles",
    "stage-overlays.css",
  );
  const css = readFileSync(cssPath, "utf-8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  it("AC2：z-index 宣告恰好三筆，分別屬於 .stage-geometry(1)／.stage-widgets(2)／.comment-composer(5)", () => {
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

  it("AC3：幾何層強制穿透規則逐字存在——`.stage-geometry, .stage-geometry * { pointer-events: none !important }`", () => {
    const normalized = withoutComments.replace(/\s+/g, "");
    expect(normalized).toContain(".stage-geometry,.stage-geometry*{pointer-events:none!important;}");
  });

  // [E5.T7]/F-17 決定 8：情境列預設穿透（ghost），`.is-solid` 才開回可點——
  // specificity 0,3,0 蓋過 `.stage-widgets > .context-bar` 的 0,2,0，兩者都
  // 逐字存在才是「情境列自己處理 hover」真正生效，不是只改了外觀。
  it("F-17：情境列預設 pointer-events:none，`.is-solid` 才開回 auto", () => {
    const normalized = withoutComments.replace(/\s+/g, "");
    expect(normalized).toContain(".stage-widgets>.context-bar{pointer-events:none;}");
    expect(normalized).toContain(".stage-widgets>.context-bar.is-solid{pointer-events:auto;}");
  });
});
