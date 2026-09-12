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
 * The comment overlay's own state, resolved by `App.tsx` (it owns
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
  /** The context bar's Edit animation button. */
  onEditAnimation(): void;
  /** The context bar's Edit style button. */
  onEditStyle(): void;
  /** The stage's numbered animation badges only show while the right rail sits on the Animate tab and the app is not in play/preview mode — neither condition belongs to `OverlayState`, so the caller (Stage.tsx) resolves them and passes the result down. */
  showBadges: boolean;
  comment: CommentOverlayProps;
  /** `state.mode !== "play"` (Stage.tsx). `OverlayLayer` itself is unconditionally mounted — `.stage-widgets` has to stay around in play mode for `EmbedLayer` — so this prop, rather than an external mount/unmount, decides whether the geometry layer and every other interactive child layer exist. */
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
 * How long the pointer must stay over/away from the
 * context bar before it flips ghost<->solid — see `createHoverSolidifier`'s
 * own doc comment for the flicker-prevention contract these gate. Exported
 * for the unit tests that pin these exact values (and for `03-UI_RATIONALE.md`
 * §C, which documents them by name).
 */
export const HOVER_SOLIDIFY_MS = 120;
export const HOVER_GHOST_MS = 250;

/** `controller.subscribeOverlay`'s parent-document client px -> `.stage-overlays`-relative px, given the well's own `getBoundingClientRect()` offset. Exported so the coordinate math itself is directly unit-testable without mounting the whole layer. */
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
 * The context bar's own hover-solidify state (`.is-solid`
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
 * Anti-flicker double-delay between ghost (translucent + `pointer-events:none`)
 * and solid (opaque + `pointer-events:auto`): entering the rect requires
 * staying inside for `solidifyMs` before switching to solid, leaving it
 * requires staying outside for `ghostMs` before switching back to ghost; a
 * mid-transition reversal before either delay elapses (a quick pass-through,
 * edge jitter) cancels the pending timer, so neither state ever switches
 * early or by mistake.
 * `onChange` is called exactly once when the state actually changes, not on
 * every `update()` call.
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
        // other direction) might still be pending, same "edge jitter never
        // flickers back and forth" contract as a same-direction repeat.
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
 * The stage overlay: after splitting into two layers, this returns a
 * fragment of two containers that sit above `.canvas` and do **not** deform
 * along with `.stage`'s own zoom/pan transform (all `getBoundingClientRect()`
 * conversion happens here via `toLocal*`, reading `wellRef`'s current box):
 * - `.stage-geometry`: GuideLayer (snap alignment guides) + BadgeLayer
 *   (animation number badges), the whole layer `pointer-events: none !important`
 *   (stage-overlays.css), mounted only while `shellVisible`.
 * - `.stage-widgets`: EmbedLayer is fixed as the first child (kept in play
 *   mode too — see the note outside the `shellVisible` gate below); the rest
 *   (SelectionOverlay/ContextBar — Order/Duplicate/Delete are wired up,
 *   the rest are layout placeholders; CommentLayer/TableOverlay/
 *   ChartWindow/children) mount only while `shellVisible`, same as the
 *   geometry layer. The container itself is always mounted (see render).
 *
 * Coordinates are only re-read from `wellRef`'s box when
 * `controller.subscribeOverlay` pushes a new state. A pure zoom/pan of the
 * stage (Stage.tsx's zoomPan state) does not make the runtime re-send
 * bounds, so Stage.tsx calls `controller.refreshOverlay()` after a zoomPan
 * change so canvas.ts recalculates from the new frame position and pushes
 * again — labels/context bar/right-click menu therefore track the slide
 * without waiting for the next selection change.
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

  // `OverlayLayer` is now unconditionally mounted (see render below), so
  // each of these three subscriptions gets its own `shellVisible` gate,
  // keeping "no subscription in play mode, state reset to empty" identical
  // to before the two-layer split — `EmbedLayer` is unaffected, since it
  // subscribes to its own `subscribeEmbeds` and doesn't go through here.
  useEffect(() => {
    if (!controller || !shellVisible) {
      setOverlay(EMPTY_OVERLAY);
      return;
    }
    return controller.subscribeOverlay(setOverlay);
  }, [controller, shellVisible]);

  // The context bar's own hover tracking — two sources feed
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

  // When rect is null (no selection, or a drag in progress), reset to ghost
  // immediately and clear any pending timer — no need to wait for the next
  // hover event to discover "there's no bar left to hover over".
  useEffect(() => {
    if (overlay.union === null || overlay.dragging) {
      hoverSolidifierRef.current?.reset();
    }
  }, [overlay.union, overlay.dragging]);

  // A single selected table renders `TableOverlay` — this is
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

  // The chart data window's own state, self-
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
        {/* Deliberately the first child so its React position index
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
                // Verified against headless Chromium: both the keyboard shortcut
                // and this button always go through the async `navigator.clipboard`
                // API (see canvas.ts controller and App.tsx's keydown handler) —
                // this is the same logic as ⌘C.
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
