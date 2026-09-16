// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import {
  decomposeMatrix,
  formatTransform,
  snapTranslation,
  composeMatrices,
  applyMatrixToPoint,
  invertMatrix,
  type Matrix,
  type Rect,
  type TransformParts,
  type SnapCandidate,
  type SnapGuide,
} from "../geometry.js";
import type { SlideElement, SlideModel } from "../slide-dom.js";
import {
  SNAP_THRESHOLD_PX,
  HUMAN_RENEW_THROTTLE_MS,
  roundsToZero,
  rectsIntersect,
  subtreeIds,
  subtreeForcesUniformScale,
  OPPOSITE_CORNER,
  cornerPoint,
  type ActiveGesture,
  type Viewport,
  type OriginalTransform,
  type MoveGesture,
  type ScaleGesture,
  type RotateGesture,
  type TextboxWidthGesture,
} from "./gesture-geometry.js";

/**
 * Everything the move/scale/rotate/textbox-width/marquee gesture functions
 * read off the current slide — grouped apart from `GestureDeps`'s other
 * fields because every member here is about resolving "what's on the slide
 * right now", never about the gesture's own in-progress state.
 */
export interface GestureSlideDeps {
  /** `slides[currentIndex]` — the slide path a committed gesture's command targets. */
  slidePath(): string;
  currentSlideModel(): SlideModel | null;
  elementIndex(): Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }>;
  /** `id`'s full container-chain bounds, off the runtime's last `element-bounds` report. */
  computeBounds(id: string): Rect | null;
  /** The runtime's last-reported per-id bounding boxes — read directly (not through `computeBounds`) by the scale gesture's non-uniform resize anchor lookup. */
  elementBoundsById: ReadonlyMap<string, { slide: Rect; local: Rect }>;
}

/** The human-editing-lease throttle (T5/NOOP-110) a committed drag/scale/rotate/textbox-width gesture renews as it goes. */
export interface GestureEditingLeaseDeps {
  begin(): void;
  end(): void;
  /** `Date.now()` of the last `begin()` call — read to throttle renewal to once per `HUMAN_RENEW_THROTTLE_MS`. */
  lastRenewAt(): number;
}

/** The "keep the selection across the reload a committed write triggers" seam (render()'s own `pendingSelectionIds`). */
export interface GesturePendingSelectionDeps {
  keepAcrossReload(): void;
  pendingSelectionIds(): string[] | null;
}

/** The three ways a gesture tells the rest of the module its state changed. */
export interface GesturePublishDeps {
  notify(): void;
  notifyOverlay(): void;
  pushSelectionToRuntime(ids: readonly string[]): void;
}

/**
 * The five frame/viewport coordinate-conversion helpers every gesture kind
 * uses — kept as a single field, rather than moved into `gestures.ts`
 * alongside the gesture functions themselves, to stay under this module's
 * 900-line cap without splitting them into a second file of their own.
 */
export interface GestureCoordsDeps {
  /** Host document client px -> iframe-local client px (NOOP-382's move-gesture boundary-crossing fallback). */
  toFrameClientPoint(point: { x: number; y: number }): { x: number; y: number };
  /** iframe-local client px -> this slide's user units, via the runtime's last-reported viewport mapping. */
  toUserPoint(point: { x: number; y: number }): { x: number; y: number };
  userXToClient(x: number): number;
  userYToClient(y: number): number;
  offsetUnion(rects: readonly Rect[], dx: number, dy: number): Rect;
}

/**
 * What `canvas/gestures.ts`'s move/scale/rotate/textbox-width/marquee
 * factory needs from the `mountCanvas` closure — declared here (the module
 * it serves, ADR-0024's own convention) and constructed once by the entry.
 * Circularity with the rest of the closure is broken by these callback
 * fields, never by an import in the other direction.
 */
export interface GestureDeps {
  /** The one gesture in progress, or `null` between gestures — a single shared slot, also read by `canvas/runtime-message-handlers.ts`. */
  activeGesture: { get(): ActiveGesture | null; set(value: ActiveGesture | null): void };
  /** Read-only for gesture purposes: the runtime's last-reported viewport mapping and the race-guard generation counter. */
  frame: { readonly viewport: Viewport | null; readonly generation: number };
  selection: { ids: string[]; names: (string | null)[]; groupPath: string[] };
  /** Only the two fields a gesture itself paints: snap guides and the drag/settle flag. */
  overlay: { guides: { orientation: "v" | "h"; position: number }[]; settling: boolean };
  slide: GestureSlideDeps;
  editingLease: GestureEditingLeaseDeps;
  pendingSelection: GesturePendingSelectionDeps;
  publish: GesturePublishDeps;
  coords: GestureCoordsDeps;
  toParentClientPoint(point: { x: number; y: number }): { x: number; y: number };
  postToFrame(message: Record<string, unknown>): void;
  postCommand(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: unknown }>;
  setError(message: string): void;
  isDestroyed(): boolean;
}

/** The begin/update/end handlers for every gesture kind, plus the two host-level pointer listeners that catch a move drag once the pointer has left the sandboxed iframe (NOOP-382) — everything `canvas.ts` wires in place of the functions this factory took over. */
export interface GestureHandlers {
  beginMove(point: { x: number; y: number }): void;
  updateMove(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void;
  endMove(cancelled: boolean): Promise<void>;
  beginScale(point: { x: number; y: number }, corner: "nw" | "ne" | "sw" | "se"): void;
  updateScale(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void;
  endScale(point: { x: number; y: number }, cancelled: boolean): Promise<void>;
  beginRotate(point: { x: number; y: number }): void;
  updateRotate(point: { x: number; y: number }): void;
  endRotate(point: { x: number; y: number }, cancelled: boolean): Promise<void>;
  beginTextboxWidth(point: { x: number; y: number }, handle: "left" | "right"): void;
  updateTextboxWidth(point: { x: number; y: number }): void;
  endTextboxWidth(point: { x: number; y: number }, cancelled: boolean): Promise<void>;
  beginMarquee(point: { x: number; y: number }): void;
  updateMarquee(point: { x: number; y: number }): void;
  endMarquee(point: { x: number; y: number }, cancelled: boolean): void;
  onHostPointerMove(event: PointerEvent): void;
  onHostPointerUp(): void;
}

export function createGestures(gestureDeps: GestureDeps): GestureHandlers {
  function beginMoveGesture(point: { x: number; y: number }): void {
    // NOOP-382: every early return here used to be silent — a drag would
    // simply not start, with no preview, no history entry, and nothing in
    // the console to say why. Each guard below now warns identifiably so a
    // future regression in any of these preconditions is diagnosable from
    // the console alone instead of requiring a fresh investigation.
    if (gestureDeps.selection.ids.length === 0) {
      console.warn("[beginMoveGesture] abort: no selection");
      return;
    }
    if (!gestureDeps.slide.currentSlideModel()) {
      console.warn("[beginMoveGesture] abort: currentSlideModel is null");
      return;
    }
    // Without this guard, toUserPoint(point) silently returns { x: 0, y: 0 }
    // when the runtime's first "viewport" message has not landed yet, and
    // that becomes the gesture's startUser with no indication anything went
    // wrong — every subsequent delta is then measured from the wrong
    // origin (NOOP-328: traced to a 180px-off drag landing spot). Declining
    // to start the gesture at all is the same posture updateMoveGesture
    // already takes on every subsequent move while frame.viewport is null.
    if (!gestureDeps.frame.viewport) {
      console.warn("[beginMoveGesture] abort: viewport is null (first 'viewport' message has not landed yet)");
      return;
    }
    const index = gestureDeps.slide.elementIndex();
    const originals = new Map<string, OriginalTransform>();
    for (const id of gestureDeps.selection.ids) {
      const entry = index.get(id);
      if (!entry) continue;
      try {
        originals.set(id, { transform: entry.element.transform, parts: decomposeMatrix(entry.element.matrix) });
      } catch {
        // A skewed/degenerate matrix cannot be decomposed — skip this id
        // rather than aborting the whole gesture for the rest of a
        // multi-selection.
      }
    }
    if (originals.size === 0) {
      console.warn("[beginMoveGesture] abort: none of the selected ids resolved to a decomposable transform");
      return;
    }
    gestureDeps.activeGesture.set({
      kind: "move",
      ids: [...originals.keys()],
      originals,
      startUser: gestureDeps.coords.toUserPoint(point),
      lastDelta: { dx: 0, dy: 0 },
    });
  }

  function updateMoveGesture(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void {
    const gesture = gestureDeps.activeGesture.get();
    if (!gesture || gesture.kind !== "move" || !gestureDeps.frame.viewport) return;
    const now = gestureDeps.coords.toUserPoint(point);
    let dx = now.x - gesture.startUser.x;
    let dy = now.y - gesture.startUser.y;
    let guides: SnapGuide[] = [];

    if (!modifiers.alt) {
      const index = gestureDeps.slide.elementIndex();
      const movingRects = gesture.ids.map((id) => gestureDeps.slide.computeBounds(id)).filter((r): r is Rect => r !== null);
      if (movingRects.length > 0) {
        const moving = gestureDeps.coords.offsetUnion(movingRects, dx, dy);
        // Excludes the dragged id(s) themselves (as before), PLUS every one
        // of their own ancestors and descendants (NOOP-91 follow-up: group
        // editing is the first scenario that can drag a NESTED element).
        // Without this, a single-child group is its own snap candidate —
        // its bounds are identical to its only child's, so dragging that
        // child would spuriously "snap" against its own unmoving parent
        // (found while building this ticket's own group-edit test, not
        // from any prior gate).
        const excluded = new Set<string>(gesture.ids);
        for (const id of gesture.ids) {
          const entry = index.get(id);
          if (!entry) continue;
          for (const ancestorId of entry.ancestorIds) excluded.add(ancestorId);
          subtreeIds(entry.element, excluded);
        }
        const candidates: SnapCandidate[] = [];
        for (const id of index.keys()) {
          if (excluded.has(id)) continue;
          const bounds = gestureDeps.slide.computeBounds(id);
          if (bounds) candidates.push({ id, bounds });
        }
        const thresholdUser = SNAP_THRESHOLD_PX * (gestureDeps.frame.viewport.viewBox.width / gestureDeps.frame.viewport.svgRect.width);
        try {
          const result = snapTranslation({
            moving,
            candidates,
            canvas: { width: gestureDeps.frame.viewport.viewBox.width, height: gestureDeps.frame.viewport.viewBox.height },
            threshold: thresholdUser,
          });
          dx += result.dx;
          dy += result.dy;
          guides = result.guides;
        } catch {
          // Malformed frame.viewport/bounds (should not happen given the
          // isValidRect/computeBounds guards above) — fall back to the
          // unsnapped delta rather than freezing the drag.
        }
      }
    }

    gesture.lastDelta = { dx, dy };
    const items = gesture.ids.map((id) => {
      const original = gesture.originals.get(id)!;
      const parts: TransformParts = { ...original.parts, translateX: original.parts.translateX + dx, translateY: original.parts.translateY + dy };
      return { id, transform: formatTransform(parts) };
    });
    gestureDeps.postToFrame({ command: "preview", items });
    // NOOP-90/T2 ADR-0011 amend: guides are drawn by the PARENT document's
    // own GuideLayer overlay now, not inside the sandboxed iframe — a
    // client-px position converts the same way a point's own coordinate
    // does (toParentClientPoint), just for one axis at a time.
    gestureDeps.overlay.guides = guides.map((guide) => ({
      orientation: guide.orientation,
      position:
        guide.orientation === "v"
          ? gestureDeps.toParentClientPoint({ x: gestureDeps.coords.userXToClient(guide.position), y: 0 }).x
          : gestureDeps.toParentClientPoint({ x: 0, y: gestureDeps.coords.userYToClient(guide.position) }).y,
    }));
    gestureDeps.publish.notifyOverlay();
  }

  function revertMovePreview(gesture: MoveGesture): void {
    const items = gesture.ids.map((id) => ({ id, transform: gesture.originals.get(id)!.transform ?? "" }));
    gestureDeps.postToFrame({ command: "preview", items });
  }
  async function endMoveGesture(cancelled: boolean): Promise<void> {
    const gesture = gestureDeps.activeGesture.get();
    gestureDeps.activeGesture.set(null);
    if (!gesture || gesture.kind !== "move") return;
    gestureDeps.overlay.guides = [];
    gestureDeps.publish.notifyOverlay();

    if (cancelled) {
      revertMovePreview(gesture);
      return;
    }
    if (roundsToZero(gesture.lastDelta.dx) && roundsToZero(gesture.lastDelta.dy)) {
      // No real movement after snapping — do not create an empty undo step.
      revertMovePreview(gesture);
      return;
    }

    const thisGeneration = gestureDeps.frame.generation;
    const result = await gestureDeps.postCommand("element move", {
      slidePath: gestureDeps.slide.slidePath(),
      elementIds: gesture.ids,
      dx: gesture.lastDelta.dx,
      dy: gesture.lastDelta.dy,
    });
    // A reload() (e.g. from the live-reload /api/events push, or the
    // author navigating away) superseded this gesture while the request
    // was in flight — its result is stale, and the reload's own render()
    // has already replaced the srcdoc wholesale, discarding any preview.
    if (gestureDeps.isDestroyed() || thisGeneration !== gestureDeps.frame.generation) return;

    if (!result.ok) {
      revertMovePreview(gesture);
      gestureDeps.setError(result.message);
      gestureDeps.publish.notify();
      return;
    }
    gestureDeps.pendingSelection.keepAcrossReload();
    // Success: the preview already shows the final position. The write
    // this command just made will arrive back over /api/events and drive
    // reload() on its own — this module deliberately adds no second
    // refresh path (§4.9's closing note).
  }

  /**
   * NOOP-382 root cause: the slide iframe is sandboxed (`allow-scripts`,
   * no `allow-same-origin`), which puts it in its own out-of-process
   * document. A move drag that carries the pointer past the iframe's own
   * rendered edge stops delivering pointermove/pointerup to
   * selection-runtime.js entirely — the browser's normal cross-document
   * hit-testing routes those events to whatever THIS host document shows
   * at that point instead, silently, with nothing to catch or log on
   * either side. `Element.setPointerCapture()` called inside the iframe
   * does not override this for an out-of-process sandboxed frame (verified
   * empirically against this app: the same drag still lost every event
   * past the boundary with capture requested). Confirmed with the actual
   * demo deck: a drag that stays inside the iframe's rendered area — same
   * distance, different direction — always worked, which is why the scale
   * handles looked fine while drag-to-move looked completely broken; the
   * demo's title merely sits close enough to the iframe's edge that a
   * sideways drag on it crosses the boundary.
   *
   * These two host-level listeners are the fallback for exactly the
   * portion of a move drag the iframe can no longer see once the cursor
   * has left it — registered once for the controller's lifetime (same
   * pattern as `onWindowMessage`), scoped to `activeGesture.kind === "move"`
   * only. Scale/rotate/textbox-width/marquee keep the pre-existing
   * (iframe-only) behavior untouched, matching this ticket's scope.
   */
  function onHostPointerMoveDuringMoveGesture(event: PointerEvent): void {
    const gesture = gestureDeps.activeGesture.get();
    if (!gesture || gesture.kind !== "move") return;
    updateMoveGesture(gestureDeps.coords.toFrameClientPoint({ x: event.clientX, y: event.clientY }), {
      shift: event.shiftKey,
      alt: event.altKey,
    });
    // Same renewal this gesture kind already gets from the iframe's own
    // "gesture-move" (handleSelectionMessage) — a drag that spends most of
    // its time past the boundary must not let the human editing lease
    // lapse just because it is this path, not that one, doing the reporting.
    if (Date.now() - gestureDeps.editingLease.lastRenewAt() >= HUMAN_RENEW_THROTTLE_MS) gestureDeps.editingLease.begin();
  }

  function onHostPointerUpDuringMoveGesture(): void {
    const gesture = gestureDeps.activeGesture.get();
    if (!gesture || gesture.kind !== "move") return;
    // No point conversion needed: endMoveGesture commits gesture.lastDelta,
    // already up to date from the last updateMoveGesture call (host- or
    // iframe-driven) — exactly what the iframe-originated "gesture-end"
    // path (handleSelectionMessage) also relies on.
    gestureDeps.overlay.settling = true;
    void endMoveGesture(false).then(() => {
      if (gestureDeps.pendingSelection.pendingSelectionIds() === null && gestureDeps.activeGesture.get() === null) {
        gestureDeps.overlay.settling = false;
        gestureDeps.publish.notifyOverlay();
      }
      gestureDeps.editingLease.end();
    });
  }

  // --- Scale handles (§4.2-follow-up) ---

  function beginScaleGesture(point: { x: number; y: number }, corner: "nw" | "ne" | "sw" | "se"): void {
    // Same guard as beginMoveGesture: without it, toUserPoint(point) below
    // silently returns {x:0,y:0} when frame.viewport hasn't arrived yet (NOOP-328).
    if (!gestureDeps.frame.viewport) return;
    if (gestureDeps.selection.ids.length !== 1) return;
    const id = gestureDeps.selection.ids[0];
    const entry = gestureDeps.slide.elementIndex().get(id);
    if (!entry) return;
    // NOOP-65 §7-I: a four-corner handle on a text box only ever changes
    // its declared WIDTH — font-size and the container's own transform
    // never move, and height is whatever the content re-wraps to. This
    // reuses the exact same `textbox width` gesture the left/right
    // mid-edge handles already drive (`beginTextboxWidthGesture`), just
    // entered from a corner instead: "nw"/"sw" behave like the left edge,
    // "ne"/"se" like the right edge (`computeTextboxWidth` only ever reads
    // the horizontal component of the drag). Core's `element scale`
    // command itself is untouched — this is purely a front-end handle
    // remapping (§2 item 8).
    if (entry.element.textWidth !== null) {
      beginTextboxWidthGesture(point, corner === "nw" || corner === "sw" ? "left" : "right");
      return;
    }
    let parts: TransformParts;
    try {
      parts = decomposeMatrix(entry.element.matrix);
    } catch {
      return; // Skewed/degenerate matrix — cannot decompose, no gesture.
    }
    const origin = { x: parts.translateX, y: parts.translateY };
    let parentInverse: Matrix;
    try {
      parentInverse = invertMatrix(composeMatrices(entry.ancestors));
    } catch {
      return; // Degenerate (zero-scale) ancestor chain — no ray to project onto.
    }
    const startUser = applyMatrixToPoint(parentInverse, gestureDeps.coords.toUserPoint(point));
    if (startUser.x === origin.x && startUser.y === origin.y) return; // No ray to project onto.

    let forceUniform = subtreeForcesUniformScale(entry.element);
    let localBox: Rect | null = null;
    let fullInverse: Matrix | null = null;
    let anchorLocal = { x: 0, y: 0 };
    if (!forceUniform) {
      // `elementBoundsById`'s `local` entry is exactly the box `elementBounds({
      // ancestors: [invertMatrix(own matrix)] })` used to fake by cancelling
      // the chain out (decision G1) — the runtime reports it
      // directly (`getBBox()`) instead. Absent (unmeasurable — jsdom, or a
      // genuinely gone element) or a degenerate own-matrix both fall back to
      // uniform-only rather than refusing the gesture outright.
      const local = gestureDeps.slide.elementBoundsById.get(id)?.local ?? null;
      try {
        if (local === null) throw new Error("unmeasurable");
        fullInverse = invertMatrix(composeMatrices([...entry.ancestors, entry.element.matrix]));
        localBox = local;
        anchorLocal = cornerPoint(OPPOSITE_CORNER[corner], localBox);
      } catch {
        forceUniform = true;
        localBox = null;
        fullInverse = null;
      }
    }

    gestureDeps.activeGesture.set({
      kind: "scale",
      id,
      corner,
      original: { transform: entry.element.transform, parts },
      originalMatrix: entry.element.matrix,
      forceUniform,
      origin,
      startUser,
      parentInverse,
      localBox,
      anchorLocal,
      fullInverse,
      lastMode: "scale",
      lastFactor: 1,
      lastWidth: localBox?.width ?? 0,
      lastHeight: localBox?.height ?? 0,
    });
  }

  /** `factor = ((now - origin) · (down - origin)) / |down - origin|²` — the scalar projection of "origin -> now" onto the ray "origin -> pointer-down", expressed as a fraction of that ray's own length. Both ends of the ray live in the element's parent coordinate space (see `ScaleGesture`'s doc comment). */
  function computeScaleFactor(gesture: ScaleGesture, point: { x: number; y: number }): number {
    const now = applyMatrixToPoint(gesture.parentInverse, gestureDeps.coords.toUserPoint(point));
    const downX = gesture.startUser.x - gesture.origin.x;
    const downY = gesture.startUser.y - gesture.origin.y;
    const nowX = now.x - gesture.origin.x;
    const nowY = now.y - gesture.origin.y;
    const denom = downX * downX + downY * downY;
    if (denom === 0) return NaN;
    return (nowX * downX + nowY * downY) / denom;
  }

  function revertScalePreview(gesture: ScaleGesture): void {
    gestureDeps.postToFrame({ command: "preview", items: [{ id: gesture.id, transform: gesture.original.transform ?? "" }] });
  }

  /** Minimum size a live resize preview/commit is clamped to — 3% of the slide's own width, 0.6% of its height (05-INTERACTIONS.feature's "resize" scenario). The command layer does not enforce this (decision 7: purely a GUI usability floor). */
  function minResizeSize(): { width: number; height: number } {
    return { width: 0.03 * gestureDeps.frame.viewport!.viewBox.width, height: 0.006 * gestureDeps.frame.viewport!.viewBox.height };
  }

  /**
   * Clamps a slide-frame (viewBox-space) point to the slide's own boundary —
   * 05-INTERACTIONS.feature's "resize" scenario, "never exceeds the slide":
   * dragging a resize handle past the visible edge of the slide must not
   * push the dragged corner any further than that edge, no matter how the
   * target itself is rotated or nested. Same GUI-only floor as
   * `minResizeSize` (decision 7).
   */
  function clampToViewBox(point: { x: number; y: number }): { x: number; y: number } {
    const box = gestureDeps.frame.viewport!.viewBox;
    return {
      x: Math.min(Math.max(point.x, box.x), box.x + box.width),
      y: Math.min(Math.max(point.y, box.y), box.y + box.height),
    };
  }

  /**
   * The non-uniform resize path's live preview: computes `(sx, sy)` against
   * the gesture-start `localBox`, then the SAME anchor-preserving translate
   * delta `packages/core`'s `resizeOneTarget` computes server-side — but
   * expressed as a temporary `scale(sx sy)` transform component rather than
   * a native-attribute change, since that is all the existing `preview`
   * protocol can show (see `ScaleGesture`'s doc comment for why this is
   * visually identical to the real thing). Returns `false` (no preview
   * applied) when the dragged corner has not moved past the origin at all —
   * `updateScaleGesture` then simply holds last frame's preview, the same
   * "freeze rather than show garbage" posture the uniform path already has.
   */
  function applyResizePreview(gesture: ScaleGesture, point: { x: number; y: number }): boolean {
    if (!gesture.localBox || !gesture.fullInverse) return false;
    const draggedLocal = applyMatrixToPoint(gesture.fullInverse, clampToViewBox(gestureDeps.coords.toUserPoint(point)));
    const { width: minWidth, height: minHeight } = minResizeSize();
    const width = Math.max(Math.abs(draggedLocal.x - gesture.anchorLocal.x), minWidth);
    const height = Math.max(Math.abs(draggedLocal.y - gesture.anchorLocal.y), minHeight);
    if (!(width > 0) || !(height > 0)) return false;

    const sx = width / gesture.localBox.width;
    const sy = height / gesture.localBox.height;
    const cornerLocalNew = { x: gesture.anchorLocal.x * sx, y: gesture.anchorLocal.y * sy };
    const deltaLocal = { x: gesture.anchorLocal.x - cornerLocalNew.x, y: gesture.anchorLocal.y - cornerLocalNew.y };
    const m = gesture.originalMatrix;
    // The matrix's linear part only (no translation) — deltaLocal is a
    // vector, not a point, so `m.e`/`m.f` must not be added in.
    const deltaParent = { x: m.a * deltaLocal.x + m.c * deltaLocal.y, y: m.b * deltaLocal.x + m.d * deltaLocal.y };

    gesture.lastMode = "resize";
    gesture.lastWidth = width;
    gesture.lastHeight = height;
    const parts: TransformParts = {
      ...gesture.original.parts,
      translateX: gesture.original.parts.translateX + deltaParent.x,
      translateY: gesture.original.parts.translateY + deltaParent.y,
      scaleX: gesture.original.parts.scaleX * sx,
      scaleY: gesture.original.parts.scaleY * sy,
    };
    gestureDeps.postToFrame({ command: "preview", items: [{ id: gesture.id, transform: formatTransform(parts) }] });
    return true;
  }

  function updateScaleGesture(point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }): void {
    const gesture = gestureDeps.activeGesture.get();
    if (!gesture || gesture.kind !== "scale") return;
    if (!(gesture.forceUniform || modifiers.shift)) {
      if (applyResizePreview(gesture, point)) return;
      // Not computable this frame (e.g. dragged exactly onto the anchor) —
      // fall through to holding the last preview rather than freezing on a
      // stale non-uniform frame while the user is still trying to drag.
      return;
    }
    const factor = computeScaleFactor(gesture, point);
    // Non-positive, NaN or infinite: dragged past the origin (would flip)
    // or otherwise invalid. Freeze the preview at the last valid factor
    // rather than showing a flipped/garbage transform — endScaleGesture
    // recomputes from the final point and aborts explicitly if it is
    // still invalid there.
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    gesture.lastMode = "scale";
    gesture.lastFactor = factor;
    const parts: TransformParts = {
      ...gesture.original.parts,
      scaleX: gesture.original.parts.scaleX * factor,
      scaleY: gesture.original.parts.scaleY * factor,
    };
    gestureDeps.postToFrame({ command: "preview", items: [{ id: gesture.id, transform: formatTransform(parts) }] });
  }

  async function endScaleGesture(point: { x: number; y: number }, cancelled: boolean): Promise<void> {
    const gesture = gestureDeps.activeGesture.get();
    gestureDeps.activeGesture.set(null);
    if (!gesture || gesture.kind !== "scale") return;

    if (cancelled) {
      revertScalePreview(gesture);
      return;
    }

    if (gesture.lastMode === "resize" && gesture.localBox) {
      if (roundsToZero(gesture.lastWidth - gesture.localBox.width) && roundsToZero(gesture.lastHeight - gesture.localBox.height)) {
        revertScalePreview(gesture);
        return;
      }
      const thisGeneration = gestureDeps.frame.generation;
      const result = await gestureDeps.postCommand("element resize", {
        slidePath: gestureDeps.slide.slidePath(),
        elementIds: [gesture.id],
        width: gesture.lastWidth,
        height: gesture.lastHeight,
        anchor: OPPOSITE_CORNER[gesture.corner],
      });
      if (gestureDeps.isDestroyed() || thisGeneration !== gestureDeps.frame.generation) return;
      if (!result.ok) {
        revertScalePreview(gesture);
        gestureDeps.setError(result.message);
        gestureDeps.publish.notify();
        return;
      }
      gestureDeps.pendingSelection.keepAcrossReload();
      // Success: same "no second refresh path" reasoning as endMoveGesture.
      return;
    }

    const factor = computeScaleFactor(gesture, point);
    if (!(factor > 0) || !Number.isFinite(factor)) {
      revertScalePreview(gesture);
      gestureDeps.setError("scale factor must be positive (dragged past the origin)");
      gestureDeps.publish.notify();
      return;
    }
    if (roundsToZero(factor - 1)) {
      revertScalePreview(gesture);
      return;
    }

    const thisGeneration = gestureDeps.frame.generation;
    const result = await gestureDeps.postCommand("element scale", {
      slidePath: gestureDeps.slide.slidePath(),
      elementIds: [gesture.id],
      factor,
    });
    if (gestureDeps.isDestroyed() || thisGeneration !== gestureDeps.frame.generation) return;
    if (!result.ok) {
      revertScalePreview(gesture);
      gestureDeps.setError(result.message);
      gestureDeps.publish.notify();
      return;
    }
    gestureDeps.pendingSelection.keepAcrossReload();
    // Success: same "no second refresh path" reasoning as endMoveGesture.
  }

  // --- Rotate handle (§4.2-follow-up) ---

  function beginRotateGesture(point: { x: number; y: number }): void {
    // Same guard as beginMoveGesture: without it, toUserPoint(point) below
    // silently returns {x:0,y:0} when frame.viewport hasn't arrived yet (NOOP-328).
    if (!gestureDeps.frame.viewport) return;
    if (gestureDeps.selection.ids.length !== 1) return;
    const id = gestureDeps.selection.ids[0];
    const entry = gestureDeps.slide.elementIndex().get(id);
    if (!entry) return;
    let parts: TransformParts;
    try {
      parts = decomposeMatrix(entry.element.matrix);
    } catch {
      return;
    }
    const origin = { x: parts.translateX, y: parts.translateY };
    let parentInverse: Matrix;
    try {
      parentInverse = invertMatrix(composeMatrices(entry.ancestors));
    } catch {
      return; // Degenerate (zero-scale) ancestor chain — angle undefined.
    }
    const startUser = applyMatrixToPoint(parentInverse, gestureDeps.coords.toUserPoint(point));
    const vx = startUser.x - origin.x;
    const vy = startUser.y - origin.y;
    if (vx === 0 && vy === 0) return; // Pointer-down coincides with the origin — angle undefined, gesture never starts.
    gestureDeps.activeGesture.set({
      kind: "rotate",
      id,
      original: { transform: entry.element.transform, parts },
      origin,
      parentInverse,
      lastAngleDeg: (Math.atan2(vy, vx) * 180) / Math.PI,
      cumulativeDeltaDeg: 0,
    });
  }

  /** Advances `gesture`'s unwrapped cumulative angle to `point`, normalizing each frame's own delta into (-180, 180] before accumulating — this is what lets a drag exceed ±360° across multiple revolutions instead of clamping at the atan2 discontinuity. Returns false (and leaves the gesture untouched) when `point` sits exactly on the origin, where the angle is undefined. `point` is mapped into the element's parent coordinate space via `gesture.parentInverse` before its angle relative to `origin` is measured (see `RotateGesture`'s doc comment). */
  function advanceRotateGesture(gesture: RotateGesture, point: { x: number; y: number }): boolean {
    const now = applyMatrixToPoint(gesture.parentInverse, gestureDeps.coords.toUserPoint(point));
    const vx = now.x - gesture.origin.x;
    const vy = now.y - gesture.origin.y;
    if (vx === 0 && vy === 0) return false;
    const nowAngleDeg = (Math.atan2(vy, vx) * 180) / Math.PI;
    let diff = nowAngleDeg - gesture.lastAngleDeg;
    while (diff > 180) diff -= 360;
    while (diff <= -180) diff += 360;
    gesture.cumulativeDeltaDeg += diff;
    gesture.lastAngleDeg = nowAngleDeg;
    return true;
  }

  function revertRotatePreview(gesture: RotateGesture): void {
    gestureDeps.postToFrame({ command: "preview", items: [{ id: gesture.id, transform: gesture.original.transform ?? "" }] });
  }

  function updateRotateGesture(point: { x: number; y: number }): void {
    const gesture = gestureDeps.activeGesture.get();
    if (!gesture || gesture.kind !== "rotate") return;
    if (!advanceRotateGesture(gesture, point)) return;
    const parts: TransformParts = { ...gesture.original.parts, rotation: gesture.original.parts.rotation + gesture.cumulativeDeltaDeg };
    gestureDeps.postToFrame({ command: "preview", items: [{ id: gesture.id, transform: formatTransform(parts) }] });
  }

  async function endRotateGesture(point: { x: number; y: number }, cancelled: boolean): Promise<void> {
    const gesture = gestureDeps.activeGesture.get();
    gestureDeps.activeGesture.set(null);
    if (!gesture || gesture.kind !== "rotate") return;

    if (cancelled) {
      revertRotatePreview(gesture);
      return;
    }
    advanceRotateGesture(gesture, point);
    const degrees = gesture.cumulativeDeltaDeg;
    if (roundsToZero(degrees)) {
      revertRotatePreview(gesture);
      return;
    }

    const thisGeneration = gestureDeps.frame.generation;
    const result = await gestureDeps.postCommand("element rotate", {
      slidePath: gestureDeps.slide.slidePath(),
      elementIds: [gesture.id],
      degrees,
    });
    if (gestureDeps.isDestroyed() || thisGeneration !== gestureDeps.frame.generation) return;
    if (!result.ok) {
      revertRotatePreview(gesture);
      gestureDeps.setError(result.message);
      gestureDeps.publish.notify();
      return;
    }
    gestureDeps.pendingSelection.keepAcrossReload();
  }

  // --- Textbox-width handles (decision (b): only the box updates during the drag, the <text> stays put) ---

  function beginTextboxWidthGesture(point: { x: number; y: number }, handle: "left" | "right"): void {
    // Same guard as beginMoveGesture: without it, toUserPoint(point) below
    // silently returns {x:0,y:0} when frame.viewport hasn't arrived yet.
    if (!gestureDeps.frame.viewport) return;
    if (gestureDeps.selection.ids.length !== 1) return;
    const id = gestureDeps.selection.ids[0];
    const entry = gestureDeps.slide.elementIndex().get(id);
    if (!entry || entry.element.textWidth === null) return;

    gestureDeps.activeGesture.set({
      kind: "textbox-width",
      id,
      handle,
      originalWidth: entry.element.textWidth,
      originalTransform: entry.element.transform,
      startUserX: gestureDeps.coords.toUserPoint(point).x,
      lastWidth: entry.element.textWidth,
    });
  }

  function computeTextboxWidth(gesture: TextboxWidthGesture, point: { x: number; y: number }): number {
    const nowX = gestureDeps.coords.toUserPoint(point).x;
    const dx = nowX - gesture.startUserX;
    // The container's own transform never changes (`textbox width` has no
    // position input) — the box's left edge stays pinned at the local
    // origin regardless of which handle is dragged (see TextboxWidthGesture's
    // own doc comment). Dragging the right handle further right, or the
    // left handle further left (away from the box), both grow the width.
    return gesture.handle === "right" ? gesture.originalWidth + dx : gesture.originalWidth - dx;
  }

  /** Tells the runtime to show `width` — it only ever updates `data-slidra-text-width` and the selection box/handles (`selectionClientRect` in selection-runtime.js), never the `<text>` content itself. */
  function previewTextboxWidth(id: string, width: number): void {
    gestureDeps.postToFrame({ command: "preview-textbox-width", id, width });
  }

  function updateTextboxWidthGesture(point: { x: number; y: number }): void {
    const gesture = gestureDeps.activeGesture.get();
    if (!gesture || gesture.kind !== "textbox-width") return;
    const width = computeTextboxWidth(gesture, point);
    if (!(width > 0)) return; // Would go non-positive — freeze at the last valid preview.
    gesture.lastWidth = width;
    previewTextboxWidth(gesture.id, width);
  }

  async function endTextboxWidthGesture(point: { x: number; y: number }, cancelled: boolean): Promise<void> {
    const gesture = gestureDeps.activeGesture.get();
    gestureDeps.activeGesture.set(null);
    if (!gesture || gesture.kind !== "textbox-width") return;

    if (cancelled) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      return;
    }
    const width = computeTextboxWidth(gesture, point);
    if (!(width > 0) || roundsToZero(width)) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      gestureDeps.setError("text box width must be greater than 0");
      gestureDeps.publish.notify();
      return;
    }
    if (roundsToZero(width - gesture.originalWidth)) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      return;
    }

    const thisGeneration = gestureDeps.frame.generation;
    const result = await gestureDeps.postCommand("textbox width", {
      slidePath: gestureDeps.slide.slidePath(),
      elementId: gesture.id,
      width,
    });
    if (gestureDeps.isDestroyed() || thisGeneration !== gestureDeps.frame.generation) return;
    if (!result.ok) {
      previewTextboxWidth(gesture.id, gesture.originalWidth);
      gestureDeps.setError(result.message);
      gestureDeps.publish.notify();
      return;
    }
    gestureDeps.pendingSelection.keepAcrossReload();
  }
  // --- Marquee select (§4.8's "marquee select" row) ---

  function beginMarqueeGesture(point: { x: number; y: number }): void {
    gestureDeps.activeGesture.set({ kind: "marquee", startClient: point });
  }

  function updateMarqueeGesture(point: { x: number; y: number }): void {
    const gesture = gestureDeps.activeGesture.get();
    if (!gesture || gesture.kind !== "marquee") return;
    const rect: Rect = {
      x: Math.min(gesture.startClient.x, point.x),
      y: Math.min(gesture.startClient.y, point.y),
      width: Math.abs(point.x - gesture.startClient.x),
      height: Math.abs(point.y - gesture.startClient.y),
    };
    gestureDeps.postToFrame({ command: "marquee", rect });
  }

  function endMarqueeGesture(point: { x: number; y: number }, cancelled: boolean): void {
    const gesture = gestureDeps.activeGesture.get();
    gestureDeps.activeGesture.set(null);
    if (!gesture || gesture.kind !== "marquee") return;
    gestureDeps.postToFrame({ command: "marquee", rect: null });
    const slideModel = gestureDeps.slide.currentSlideModel();
    if (cancelled || !slideModel || !gestureDeps.frame.viewport) return;

    const a = gestureDeps.coords.toUserPoint(gesture.startClient);
    const b = gestureDeps.coords.toUserPoint(point);
    const marqueeRect: Rect = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };

    const hitIds: string[] = [];
    const hitNames: (string | null)[] = [];
    for (const element of slideModel.elements) {
      // A locked element is not selectable at all (ADR-0013). The click
      // path already refuses it inside the runtime; the marquee resolves
      // hits out here against reported bounds, which include every element
      // with an id — so without this the full-bleed background image was
      // caught by every single marquee.
      if (element.locked) continue;
      const bounds = gestureDeps.slide.computeBounds(element.id);
      // An element the runtime never reported bounds for (jsdom in tests,
      // or a genuinely gone element) is simply not selectable by marquee —
      // same degradation `computeBounds`'s callers already apply elsewhere.
      if (bounds && rectsIntersect(marqueeRect, bounds)) {
        hitIds.push(element.id);
        hitNames.push(element.name);
      }
    }
    gestureDeps.selection.ids = hitIds;
    gestureDeps.selection.names = hitNames;
    // Marquee always operates at the top level (the loop above walks
    // currentSlideModel.elements, never a group's children) — it
    // unconditionally exits any group-edit scope, same as clicking outside
    // the entered group would.
    gestureDeps.selection.groupPath = [];
    gestureDeps.publish.notify();
    gestureDeps.publish.pushSelectionToRuntime(hitIds);
  }

  return {
    beginMove: beginMoveGesture,
    updateMove: updateMoveGesture,
    endMove: endMoveGesture,
    beginScale: beginScaleGesture,
    updateScale: updateScaleGesture,
    endScale: endScaleGesture,
    beginRotate: beginRotateGesture,
    updateRotate: updateRotateGesture,
    endRotate: endRotateGesture,
    beginTextboxWidth: beginTextboxWidthGesture,
    updateTextboxWidth: updateTextboxWidthGesture,
    endTextboxWidth: endTextboxWidthGesture,
    beginMarquee: beginMarqueeGesture,
    updateMarquee: updateMarqueeGesture,
    endMarquee: endMarqueeGesture,
    onHostPointerMove: onHostPointerMoveDuringMoveGesture,
    onHostPointerUp: onHostPointerUpDuringMoveGesture,
  };
}
