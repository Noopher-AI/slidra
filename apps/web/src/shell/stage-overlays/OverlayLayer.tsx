import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CanvasController, CanvasState, ChartWindowState, OverlayState } from "../../canvas.js";
import { SelectionOverlay } from "./SelectionOverlay.js";
import { ContextBar } from "./ContextBar.js";
import { CommentLayer } from "./CommentLayer.js";
import { GuideLayer } from "./GuideLayer.js";
import { BadgeLayer } from "./BadgeLayer.js";
import { TableOverlay } from "./TableOverlay.js";
import { ChartWindow } from "./ChartWindow.js";
import { EmbedLayer } from "./EmbedLayer.js";

/**
 * [E2.T8]: the comment overlay's own state, resolved by `App.tsx` (it owns
 * the deck-wide comment list and the current selection) and threaded down
 * here so `OverlayLayer` only has to turn it into props for `ContextBar` /
 * `SelectionOverlay` / `CommentLayer` — none of which know about comments
 * on their own.
 */
export interface CommentOverlayProps {
  /** The single selected element's own comment, or `null` when it has none (multi-selection is resolved to `null` by the caller too — no pin for 2+, `slidra-logic-v3.js:666`). */
  pin: { commentId: string; number: number; onClick(): void } | null;
  /** `null` = composer closed; an element id or `"page"` = open, targeting that. */
  target: string | null;
  /** The comment id being edited, or `null` for a brand-new one. */
  editingCommentId: string | null;
  draft: string;
  onDraftChange(text: string): void;
  /** "Comment to AI" click — resolves target/edit-mode from the live selection. */
  onOpenForSelection(): void;
  onSubmit(): void;
  onDelete(): void;
  onClose(): void;
}

export interface OverlayLayerProps {
  controller: CanvasController | null;
  /** `.canvas-area`'s own ref (Stage.tsx) — `.stage-overlays` is positioned relative to it, so every value `controller.subscribeOverlay` reports (parent-document client px) needs this element's own `getBoundingClientRect()` subtracted before it means anything as a `left`/`top` CSS value here. */
  wellRef: RefObject<HTMLDivElement | null>;
  /** [E2.T7]：情境列的 Edit animation 按鈕。 */
  onEditAnimation(): void;
  /** #200 §4.5：情境列的 Edit style 按鈕。 */
  onEditStyle(): void;
  /** [E2.T7]/D9：右欄停在 Animate 分頁且非播放／預覽模式時才顯示舞台編號徽章——這兩個條件都不屬於 `OverlayState`，由呼叫方（Stage.tsx）判斷後傳下來。 */
  showBadges: boolean;
  comment: CommentOverlayProps;
  /** [E5.T3]：`state.mode !== "play"`（Stage.tsx）。`OverlayLayer` 本身無條件掛載——`.stage-widgets` 必須在播放模式也留著給 `EmbedLayer`——所以由這個 prop 而非外部的掛載/卸載，決定幾何層與其餘所有可互動子層要不要存在。 */
  shellVisible: boolean;
  children?: ReactNode;
}

const EMPTY_OVERLAY: OverlayState = {
  boxes: [],
  union: null,
  label: null,
  guides: [],
  dragging: false,
  hasAnimation: false,
  badges: [],
};

/**
 * [E5.T7]/F-17 決定 8: how long the pointer must stay over/away from the
 * context bar before it flips ghost<->solid — see `createHoverSolidifier`'s
 * own doc comment for the flicker-prevention contract these gate. Exported
 * for the unit tests that pin these exact values (and for `03-UI_RATIONALE.md`
 * §C, which documents them by name).
 */
export const HOVER_SOLIDIFY_MS = 120;
export const HOVER_GHOST_MS = 250;

/** `controller.subscribeOverlay`'s parent-document client px -> `.stage-overlays`-relative px, given the well's own `getBoundingClientRect()` offset. Exported so the coordinate math itself is directly unit-testable without mounting the whole layer (NOOP-91 round-2 FAIL #4). */
export function toLocalPoint(
  point: { x: number; y: number },
  offset: { x: number; y: number },
): { x: number; y: number } {
  return { x: point.x - offset.x, y: point.y - offset.y };
}

/** Same conversion as `toLocalPoint`, applied to a rect — width/height are already well-relative sizes, so only the corner shifts. */
export function toLocalRect(
  rect: { x: number; y: number; width: number; height: number },
  offset: { x: number; y: number },
): { x: number; y: number; width: number; height: number } {
  return { x: rect.x - offset.x, y: rect.y - offset.y, width: rect.width, height: rect.height };
}

/**
 * [E5.T7]/F-17: the context bar's own hover-solidify state (`.is-solid`
 * ghost/solid toggle, `stage-overlays.css`) needs "is this point on top of
 * the bar right now", against `rect` (`barRef.current.getBoundingClientRect()`)
 * — both `point` and `rect` are parent-document client px, same space
 * (`subscribeStageHover`'s conversion and a real `window.mousemove` land in
 * the same coordinate system, no well offset needed). Inclusive of the
 * edges, matching `getBoundingClientRect()`'s own "on the border counts as
 * inside" convention for hit-testing.
 */
export function pointInsideRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * [E5.T7]/F-17 決定 8: ghost（半透明＋`pointer-events:none`）/solid（不透明＋
 * `pointer-events:auto`）之間的雙延遲防閃爍——進入 rect 停留 `solidifyMs` 才轉
 * solid，離開 rect 停留 `ghostMs` 才轉回 ghost；未滿延遲就反向的中途動作（快速
 * 掃過、邊界抖動）取消還在等待的計時器，兩態都不因此提早或誤判切換。
 * `onChange` 只在狀態真的改變時呼叫一次，不是每次 `update()` 都呼叫。
 */
export function createHoverSolidifier(
  onChange: (solid: boolean) => void,
  solidifyMs: number,
  ghostMs: number,
): { update(inside: boolean): void; reset(): void } {
  let solid = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function setSolid(next: boolean): void {
    if (solid === next) return;
    solid = next;
    onChange(solid);
  }

  return {
    update(inside: boolean) {
      if (inside === solid) {
        // Already in the target state — cancel whatever transition (the
        // other direction) might still be pending, same "边界抖动不来回
        // 闪" contract as a same-direction repeat.
        clearTimer();
        return;
      }
      if (timer !== null) return; // A transition to this same target is already pending.
      const delay = inside ? solidifyMs : ghostMs;
      timer = setTimeout(() => {
        timer = null;
        setSolid(inside);
      }, delay);
    },
    reset() {
      clearTimer();
      setSolid(false);
    },
  };
}

/**
 * 舞台疊層：[E5.T3] 兩層化之後回傳兩個容器的 fragment，坐在 `.canvas` 上
 * 方，且**不**隨 `.stage` 的縮放/平移 transform 一起變形（`getBoundingClientRect()`
 * 換算全部由這裡的 `toLocal*` 做，讀 `wellRef` 當下的框）：
 * - `.stage-geometry`：GuideLayer（吸附輔助線）＋ BadgeLayer（動畫編號徽
 *   章），整層 `pointer-events: none !important`（stage-overlays.css），
 *   只在 `shellVisible` 時掛載。
 * - `.stage-widgets`：EmbedLayer 固定第一個子節點（播放模式也要留著，見
 *   `shellVisible` 之外那段），其餘（SelectionOverlay／ContextBar：Order／
 *   Duplicate／Delete 已接功能，其餘為佈局佔位；CommentLayer／TableOverlay／
 *   ChartWindow／children）跟幾何層一樣只在 `shellVisible` 時掛載。無條件
 *   掛載本身（見 render）。
 *
 * 座標只在 `controller.subscribeOverlay` 推送新狀態時重新讀 `wellRef` 的框。
 * 單純縮放/平移舞台（Stage.tsx 的 zoomPan state）不會讓 runtime 重發
 * bounds，所以 Stage.tsx 在 zoomPan 變化後呼叫 `controller.refreshOverlay()`
 * 讓 canvas.ts 用新的 frame 位置重算並再推一次——標籤/情境列/右鍵選單因此
 * 跟著投影片走，不用等下一次選取變化。
 */
export function OverlayLayer({ controller, wellRef, onEditAnimation, onEditStyle, showBadges, comment, shellVisible, children }: OverlayLayerProps) {
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
  const [selection, setSelection] = useState<CanvasState["selection"] | null>(null);
  const [slidePath, setSlidePath] = useState<string | null>(null);
  const [chartWindow, setChartWindow] = useState<ChartWindowState | null>(null);
  const [contextBarSolid, setContextBarSolid] = useState(false);
  const contextBarRef = useRef<HTMLDivElement | null>(null);
  const hoverSolidifierRef = useRef<ReturnType<typeof createHoverSolidifier> | null>(null);
  if (!hoverSolidifierRef.current) {
    hoverSolidifierRef.current = createHoverSolidifier(setContextBarSolid, HOVER_SOLIDIFY_MS, HOVER_GHOST_MS);
  }

  // [E5.T3]：`OverlayLayer` 現在無條件掛載（見下方 render），所以這三個訂閱
  // 各自加上 `shellVisible` 閘門，讓「播放模式不訂閱、狀態重設為空」與兩層
  // 化之前逐字相同——`EmbedLayer` 不受影響，它訂閱的是自己的
  // `subscribeEmbeds`，不經過這裡。
  useEffect(() => {
    if (!controller || !shellVisible) {
      setOverlay(EMPTY_OVERLAY);
      return;
    }
    return controller.subscribeOverlay(setOverlay);
  }, [controller, shellVisible]);

  // [E5.T7]/F-17: the context bar's own hover tracking — two sources feed
  // the same `pointInsideRect` check because the pointer crosses in and out
  // of the sandboxed iframe freely: `subscribeStageHover` while it is over
  // the slide, this component's own `window.mousemove` for everywhere else
  // in the parent document (both already report parent-document client px,
  // so no well offset is needed here — see `pointInsideRect`'s own doc
  // comment). Not gated on `overlay.union` — the reset effect below already
  // forces ghost the instant there is no bar to hover, so a stale "inside"
  // from just before a selection change cannot linger.
  useEffect(() => {
    if (!controller || !shellVisible) return;
    function handlePointerAt(point: { x: number; y: number }): void {
      const bar = contextBarRef.current;
      if (!bar) return;
      hoverSolidifierRef.current?.update(pointInsideRect(point, bar.getBoundingClientRect()));
    }
    const unsubscribeStageHover = controller.subscribeStageHover(handlePointerAt);
    const onMouseMove = (event: MouseEvent) => handlePointerAt({ x: event.clientX, y: event.clientY });
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      unsubscribeStageHover();
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, [controller, shellVisible]);

  // [E5.T7]/F-17 契約表：rect 為 null（沒有選取，或正在拖曳）立即重設 ghost、
  // 清掉待處理的計時器——不用等下一次 hover 事件才發現「已經沒有列可以停留」。
  useEffect(() => {
    if (overlay.union === null || overlay.dragging) {
      hoverSolidifierRef.current?.reset();
    }
  }, [overlay.union, overlay.dragging]);

  // E2.T14 §0(b): a single selected table renders `TableOverlay` — this is
  // the one place `OverlayLayer` looks at the raw selection/slide state
  // (`OverlayState` itself has no element-kind info), self-contained so no
  // new prop needs threading through `Stage.tsx`/`App.tsx`.
  useEffect(() => {
    if (!controller || !shellVisible) {
      setSelection(null);
      setSlidePath(null);
      return;
    }
    return controller.subscribe((state) => {
      setSelection(state.selection);
      setSlidePath(state.currentIndex >= 0 ? state.slides[state.currentIndex] : null);
    });
  }, [controller, shellVisible]);

  // E2.T12 plan §3.6/§4.5: the chart data window's own state, self-
  // subscribed here rather than threaded through Stage.tsx/App.tsx —
  // `controller` (which is all `subscribeChartWindow`/`closeChartWindow`/
  // `previewChart` need) already reaches this component, the same way
  // `subscribeOverlay` above is handled locally instead of lifted.
  useEffect(() => {
    if (!controller || !shellVisible) {
      setChartWindow(null);
      return;
    }
    return controller.subscribeChartWindow(setChartWindow);
  }, [controller, shellVisible]);

  const wellRect = wellRef.current?.getBoundingClientRect();
  const offsetX = wellRect?.left ?? 0;
  const offsetY = wellRect?.top ?? 0;
  const bounds = { width: wellRect?.width ?? 0, height: wellRect?.height ?? 0 };
  const offset = { x: offsetX, y: offsetY };

  const union = overlay.union ? toLocalRect(overlay.union, offset) : null;
  const guides = overlay.guides.map((guide) => ({
    orientation: guide.orientation,
    position: guide.orientation === "v" ? guide.position - offsetX : guide.position - offsetY,
  }));
  const badges = showBadges
    ? overlay.badges.map((badge) => ({ ...badge, rect: toLocalRect(badge.rect, offset) }))
    : [];

  const composerAnchor = comment.target !== null && comment.target !== "page" ? union : null;

  return (
    <>
      {shellVisible && (
        <div className="stage-geometry">
          <GuideLayer guides={guides} />
          <BadgeLayer badges={badges} onSelect={(target) => controller?.selectElements([target])} />
        </div>
      )}
      <div className="stage-widgets">
        {/* [E2.T17]：deliberately the first child so its React position index
            stays 0 across the `shellVisible` toggle below — a remount here
            would reload the iframe (video restarts from the top). Kept
            playing in play mode too, unlike everything after it. */}
        <EmbedLayer controller={controller} />
        {shellVisible && (
          <Fragment>
            <SelectionOverlay union={union} label={overlay.label} pin={comment.pin} />
            <ContextBar
              union={union}
              bounds={bounds}
              dragging={overlay.dragging}
              hasAnimation={overlay.hasAnimation}
              solid={contextBarSolid}
              barRef={contextBarRef}
              onEditAnimation={onEditAnimation}
              onEditStyle={onEditStyle}
              onComment={comment.onOpenForSelection}
              onOrder={(direction) => void controller?.orderSelection(direction)}
              onCopy={() => {
                // [E2.T18] 計畫 §3.8/A0：headless Chromium 實測，鍵盤與按鈕都一律
                // 走非同步 `navigator.clipboard` API（見 canvas.ts controller 與
                // App.tsx keydown handler 的說明）——這裡與 ⌘C 是同一組邏輯。
                void controller?.copySelection().then((svg) => {
                  if (svg) void navigator.clipboard.writeText(svg);
                });
              }}
              onCut={() => {
                void controller?.cutSelection().then((svg) => {
                  if (svg) void navigator.clipboard.writeText(svg);
                });
              }}
              onPaste={() => {
                void navigator.clipboard.readText().then((text) => controller?.pasteFromText(text));
              }}
              onDuplicate={() => void controller?.duplicateSelection()}
              onDelete={() => void controller?.deleteSelection()}
            />
            <CommentLayer
              open={comment.target !== null}
              anchor={composerAnchor}
              bounds={bounds}
              draft={comment.draft}
              onDraftChange={comment.onDraftChange}
              editingCommentId={comment.editingCommentId}
              onSubmit={comment.onSubmit}
              onDelete={comment.onDelete}
              onClose={comment.onClose}
            />
            {selection && selection.ids.length === 1 && selection.elements[0]?.kind === "table" && selection.elements[0].table && (
              <TableOverlay
                controller={controller}
                wellRef={wellRef}
                slidePath={slidePath}
                tableId={selection.ids[0]}
                table={selection.elements[0].table}
              />
            )}
            {/* `key={chartWindow.id}` remounts on a different target so its drag
                position and every draft field reset to that chart's own data —
                never carrying edit state from whichever chart was open before. */}
            {chartWindow && <ChartWindow key={chartWindow.id} state={chartWindow} controller={controller} bounds={bounds} />}
            {children}
          </Fragment>
        )}
      </div>
    </>
  );
}
