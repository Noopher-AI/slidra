// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { CanvasController, CanvasState } from "../canvas.js";
import { Dock } from "./dock/Dock.js";
import { OverlayLayer, type CommentOverlayProps } from "./stage-overlays/OverlayLayer.js";
import type { SideId } from "./side/SidePanel.js";
import {
  initialHandState,
  initialZoomPan,
  isHandActive,
  panBy,
  pressSpace,
  releaseSpace,
  setZoom,
  toggleHand,
  zoomByWheel,
  zoomFit,
  type HandState,
  type ZoomPanState,
} from "./stage-view.js";

export interface StageProps {
  /** The container canvas.ts mounts the iframe into. This DOM node's identity and position must never change. */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** The stage floor = fullscreen target = play-mode black backdrop container = the source of zoom/pan wheel and drag events. */
  wellRef: RefObject<HTMLDivElement | null>;
  /** Source of the stage's aspect ratio; falls back to CSS's 16/9 default when null. */
  canvasSize: { width: number; height: number } | null;
  state: CanvasState;
  /**
   * Wheel zoom/pan on the slide body itself, hand-mode dragging, and Space's
   * temporary grab are all forwarded through canvas.ts's
   * `subscribeStageInput`/`setStageHandMode`/`clearSelection` (the actual
   * source is selection-runtime.js). `null` (the first render, following
   * `PlayChrome`'s existing `controllerRef.current` pattern) means stage
   * navigation only works over the empty margin, without erroring, until
   * the next render gets a non-null value.
   */
  controller: CanvasController | null;
  /** The context bar's Edit animation button — only switches the right rail to Animate › Object; state is owned by App.tsx. */
  onEditAnimation(): void;
  /** The context bar's Edit style button — only switches the right rail to Style › Object; state is likewise owned by App.tsx. */
  onEditStyle(): void;
  /** Which main tab the right rail currently sits on — used only to decide whether the stage animation badges show (see OverlayLayer's showBadges). */
  side: SideId;
  /** The existing drag-and-drop media import overlay (unrelated to this skeleton, kept as-is). */
  dropOverlay: { active: boolean; onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void; onDragLeave: (event: DragEvent) => void };
  /** Comment pin/comment box state, handed over wholesale to `OverlayLayer` (App.tsx is the only place that resolves selection and the comment list). */
  comment: CommentOverlayProps;
  /** Play notifications and PlayChrome. Must render inside the fullscreen target, or they won't be clickable in fullscreen. */
  children?: ReactNode;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/** The Dock's and stage overlay's own buttons and floating layers — a mousedown landing in these containers must not be treated as "clicked on empty space" and trigger a pan. */
function isOnStageChrome(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest(".dock, .stage-geometry, .stage-widgets");
}

/** A mousedown→mouseup movement past this threshold (px) counts as a "drag" rather than a "click", used to decide whether clicking the stage's outer ring clears the selection. */
const STAGE_CLICK_THRESHOLD_PX = 3;

/**
 * The stage (New v3 skeleton): dark well → zoom/pan transform frame → the
 * existing `.canvas` div (identity unchanged) → the overlay stack (empty
 * containers, see stage-overlays/). Zoom/pan/hand-mode state is entirely
 * delegated to stage-view.ts's pure functions (see that file and
 * apps/web/test/stage-view.test.ts) — this component only wires up DOM
 * events, converts coordinates once, and calls those functions.
 *
 * `canvasRef`'s div keeps the exact same JSX position and conditions here
 * (still the one and only unconditionally-rendered child under `.stage`,
 * with no new `key`) — canvas.ts's `mountCanvas` runs exactly once and
 * holds onto this node forever; losing its identity would silently orphan
 * the mounted iframe (a blank screen, no error). `.stage` itself now also
 * carries an inline `transform` (pan + zoom), which is completely
 * transparent to canvas.ts — all of its coordinate math happens in the
 * iframe's own document coordinate space, which an ancestor's CSS
 * transform does not affect.
 */
export function Stage({ canvasRef, wellRef, canvasSize, state, dropOverlay, controller, onEditAnimation, onEditStyle, side, comment, children }: StageProps) {
  const [zoomPan, setZoomPan] = useState<ZoomPanState>(initialZoomPan);
  const [hand, setHand] = useState<HandState>(initialHandState);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPan: ZoomPanState["pan"] } | null>(null);
  // Stage navigation is fully disabled in play mode (mirroring the
  // prototype's `wellWheel`/`wellDown`, both of which return early for
  // `mode === "play"`); the Dock/overlays disappear from the DOM together
  // with `shellVisible`, matching App.tsx's existing approach for the
  // Titlebar/Rail/side panel (unmounted entirely in play mode, not just
  // hidden with CSS).
  const shellVisible = state.mode !== "play";

  // A "latest value" read port for the stage-input relay — the effect below
  // only re-subscribes when `controller` changes, but every event received
  // during that subscription needs to read the current `zoomPan`, not the
  // stale value from subscription time, hence a ref rather than closing
  // directly over the `zoomPan` state variable.
  const zoomPanRef = useRef(zoomPan);
  zoomPanRef.current = zoomPan;

  // Space's temporary grab (05-INTERACTIONS.feature's "temporary grab"):
  // holding it is equivalent to hand mode, releasing restores the previous
  // hand state; losing window focus is treated the same as releasing (so
  // it can never get stuck in grab mode); disabled while focus is on a
  // text input (mirroring App.tsx's existing ⌘Z focus guard).
  useEffect(() => {
    if (!shellVisible) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== " " && event.code !== "Space") return;
      if (isTextInputTarget(event.target)) return;
      event.preventDefault();
      setHand((current) => pressSpace(current));
    }
    function onKeyUp(event: KeyboardEvent): void {
      if (event.key !== " " && event.code !== "Space") return;
      setHand((current) => releaseSpace(current));
    }
    function onWindowBlur(): void {
      setHand((current) => releaseSpace(current));
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [shellVisible]);

  // ⌘0/⌘+/⌘=/⌘- (05-INTERACTIONS.feature's "zoom menu"/the keyboard table):
  // the same math moved to a keyboard entry point, not rewritten — the
  // ZoomMenu's +/- buttons use the same anchorless
  // `setZoom(current, current.zoom * 1.25)`, and Fit is `zoomFit`. Play
  // mode has no concept of stage zoom, so this is disabled together with
  // `shellVisible` (same as the Space effect above).
  useEffect(() => {
    if (!shellVisible) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (isTextInputTarget(event.target)) return;
      if (event.key === "0") {
        event.preventDefault();
        setZoomPan((current) => zoomFit(current));
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoomPan((current) => setZoom(current, current.zoom * 1.25));
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        setZoomPan((current) => setZoom(current, current.zoom / 1.25));
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shellVisible]);

  // Whenever hand mode (✋ or Space's temporary grab) changes, push it to
  // canvas.ts right away — it's the only party that knows whether to
  // re-push this state to selection-runtime.js (after switching slides, or
  // on "runtime-ready"); this effect only hands it the latest value.
  useEffect(() => {
    controller?.setStageHandMode(isHandActive(hand));
  }, [controller, hand]);

  // After a zoom/pan, the overlays (name label, context bar, right-click
  // menu) need to track the slide: the coordinates the runtime reports are
  // the iframe's own client px, unaffected by `.stage`'s transform — only
  // the parent-document side of the conversion goes stale, so whenever
  // zoomPan changes this asks the controller to recalculate from the new
  // frame position (the effect runs after the transform has already
  // committed).
  useEffect(() => {
    if (!shellVisible) return;
    controller?.refreshOverlay();
  }, [controller, shellVisible, zoomPan]);

  // The embedded player overlay stays alive in play mode too (EmbedLayer
  // isn't behind the `shellVisible` gate), so its own recalculation cannot
  // be blocked by `!shellVisible` along with the effect above — entering
  // or leaving play mode is exactly when `.stage`'s transform swaps and the
  // frame position changes entirely.
  useEffect(() => {
    controller?.refreshEmbeds();
  }, [controller, shellVisible, zoomPan]);

  // Wheel zoom/pan and hand-mode dragging on the slide body itself:
  // canvas.ts has already converted selection-runtime.js's reported iframe-
  // internal coordinates into this document's client coordinates, so the
  // math below is identical to what handleWheel/handleMouseDown do for the
  // empty margin — not rewritten as a separate copy.
  useEffect(() => {
    if (!controller || !shellVisible) return;
    return controller.subscribeStageInput((event) => {
      switch (event.type) {
        case "wheel-zoom": {
          const rect = wellRef.current?.getBoundingClientRect();
          const anchor = rect
            ? { x: event.point.x - rect.left - rect.width / 2, y: event.point.y - rect.top - rect.height / 2 }
            : { x: 0, y: 0 };
          setZoomPan((current) => zoomByWheel(current, event.deltaY, anchor));
          return;
        }
        case "wheel-pan":
          setZoomPan((current) => panBy(current, -event.deltaX, -event.deltaY));
          return;
        case "pan-start":
          dragRef.current = { startX: event.point.x, startY: event.point.y, startPan: zoomPanRef.current.pan };
          setDragging(true);
          return;
        case "pan-move": {
          const drag = dragRef.current;
          if (!drag) return;
          setZoomPan((current) => ({
            zoom: current.zoom,
            pan: { x: drag.startPan.x + (event.point.x - drag.startX), y: drag.startPan.y + (event.point.y - drag.startY) },
          }));
          return;
        }
        case "pan-end":
          dragRef.current = null;
          setDragging(false);
          return;
        case "space-down":
          setHand((current) => pressSpace(current));
          return;
        case "space-up":
          setHand((current) => releaseSpace(current));
          return;
      }
    });
  }, [controller, shellVisible, wellRef]);

  /**
   * The empty margin's (`.canvas-area`'s padding background) own wheel/drag
   * handling — the same operations on the slide body itself go through the
   * `subscribeStageInput` relay above, see that effect's own comment. Both
   * paths share the zoom/pan math here rather than duplicating it.
   */
  function handleWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!shellVisible || isOnStageChrome(event.target)) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // The anchor is an offset relative to the well's center (mirroring
      // the prototype's `wellWheel`), because `.stage`'s centering/pan/zoom
      // are all stacked on the same origin.
      const rect = wellRef.current?.getBoundingClientRect();
      const anchor = rect
        ? { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
        : { x: 0, y: 0 };
      setZoomPan((current) => zoomByWheel(current, event.deltaY, anchor));
    } else {
      setZoomPan((current) => panBy(current, -event.deltaX, -event.deltaY));
    }
  }

  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!shellVisible || isOnStageChrome(event.target)) return;
    const target = event.target as HTMLElement;
    const onStage = !!target.closest(".stage");
    const shouldPan = event.button === 1 || isHandActive(hand) || !onStage;
    if (!shouldPan) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startPan = zoomPan.pan;
    dragRef.current = { startX, startY, startPan };
    setDragging(true);
    // Clicking the stage's outer ring (`.canvas-area`'s dark-gray backdrop
    // outside `.stage`) should clear the selection (per
    // 06-KEYBOARD_AND_GESTURES.md's "click empty space to deselect"); the
    // mouseup ending a pan drag must not count as a "click" — `moved`
    // distinguishes the two, past the threshold counts as a drag.
    let moved = false;
    function onMove(moveEvent: globalThis.MouseEvent): void {
      const drag = dragRef.current;
      if (!drag) return;
      if (Math.abs(moveEvent.clientX - startX) > STAGE_CLICK_THRESHOLD_PX || Math.abs(moveEvent.clientY - startY) > STAGE_CLICK_THRESHOLD_PX) {
        moved = true;
      }
      setZoomPan((current) => ({
        zoom: current.zoom,
        pan: { x: drag.startPan.x + (moveEvent.clientX - drag.startX), y: drag.startPan.y + (moveEvent.clientY - drag.startY) },
      }));
    }
    function onUp(): void {
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!moved && !onStage) controller?.clearSelection();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleToggleHand(): void {
    const { state: next, selectionCleared } = toggleHand(hand);
    setHand(next);
    if (selectionCleared) {
      // 05-INTERACTIONS.feature's "hand mode": turning it on clears the
      // current selection.
      controller?.clearSelection();
    }
  }

  const aspectStyle: CSSProperties = canvasSize
    ? { aspectRatio: `${canvasSize.width} / ${canvasSize.height}` }
    : { visibility: "hidden" };
  // Play mode (!shellVisible) always renders with an identity transform,
  // ignoring the currently stored zoomPan — the existing fullscreen
  // regression contract (e2e/player-fullscreen.test.ts asserts
  // frameSize[0] === screenSize[0]) takes priority over the edit mode's
  // zoom/pan state; zoomPan itself is never cleared, so returning to view
  // mode restores the original zoom/pan exactly as it was.
  // `translate(-50%, -50%)` is the self-centering half of stage.css's
  // `top/left: 50%` trick (undoing the offset against `.stage`'s own size)
  // — always present, even during play, or `.stage` would jump to the
  // grid track's top-left corner instead of staying centred. The pan/zoom
  // portion composes after it, and is dropped entirely (not just left at
  // identity) while `!shellVisible`, per the comment above.
  const centering = "translate(-50%, -50%)";
  const stageStyle: CSSProperties = {
    ...aspectStyle,
    transform: shellVisible ? `${centering} translate(${zoomPan.pan.x}px, ${zoomPan.pan.y}px) scale(${zoomPan.zoom})` : centering,
  };
  const wellCursor = dragging ? "grabbing" : isHandActive(hand) ? "grab" : undefined;
  const deckEmpty = state.slides.length === 0;

  return (
    <div
      className="canvas-area"
      ref={wellRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      style={{ cursor: wellCursor }}
      // Grab mode (✋ or Space held): the context bar stops intercepting the
      // pointer (stage-overlays.css) so a drag that starts over it still
      // reaches the slide and pans — `isOnStageChrome` would otherwise swallow
      // that mousedown as "UI chrome".
      data-grab={isHandActive(hand) ? "true" : undefined}
    >
      <div className="stage" style={stageStyle} data-empty={deckEmpty ? "true" : undefined}>
        <div ref={canvasRef} className="canvas" />
        {/* A deck with zero slides: the stage should not show a blank white
            sheet pretending to be an empty slide (the iframe is transparent
            at this point, see canvas.ts's EMPTY_DECK_DOCUMENT) — the well's
            floor shows through directly, with only this one line of white
            text. */}
        {deckEmpty && <p className="stage-empty">No slides now</p>}
        {/* T3/NOOP-142: pointer-events stays "none" until App.tsx sets
            `active` true — otherwise this div would sit over the iframe at
            all times and swallow every click/drag NOOP-91's direct
            manipulation depends on. */}
        <div
          className="drop-overlay"
          data-active={dropOverlay.active}
          style={{ pointerEvents: dropOverlay.active ? "auto" : "none" }}
          onDragOver={(event) => {
            event.preventDefault();
            dropOverlay.onDragOver(event);
          }}
          onDrop={dropOverlay.onDrop}
          onDragLeave={dropOverlay.onDragLeave}
        />
      </div>
      {/* [E5.T3]: `OverlayLayer` is now unconditionally mounted — its own
          `.stage-widgets` container has to stay in play mode too (EmbedLayer
          keeps playing there and in fullscreen), so `shellVisible` is a prop
          it gates internally rather than a mount/unmount here. */}
      <OverlayLayer
        controller={controller}
        wellRef={wellRef}
        onEditAnimation={onEditAnimation}
        onEditStyle={onEditStyle}
        showBadges={side === "animate" && state.mode === "view"}
        comment={comment}
        shellVisible={shellVisible}
      />
      {shellVisible && (
        <Dock
          zoomPan={zoomPan}
          onZoomPanChange={setZoomPan}
          hand={hand}
          onToggleHand={handleToggleHand}
          selection={state.selection}
          controller={controller}
          slidePath={state.currentIndex >= 0 ? state.slides[state.currentIndex] : null}
          onAnimationAdded={onEditAnimation}
          canvasSize={canvasSize}
          pageStyle={state.pageStyle}
        />
      )}
      {children}
    </div>
  );
}
