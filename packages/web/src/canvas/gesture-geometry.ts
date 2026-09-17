// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Matrix, Rect, TransformParts } from "../geometry.js";
import type { SlideElement } from "../slide-dom.js";

/** Screen-space viewport the runtime last reported (client px <-> user units, NOOP-91 §4.1's "viewport" event). */
interface Viewport {
  svgRect: Rect;
  viewBox: Rect;
}

/** One selected element's transform, captured at gesture start, for preview/revert (§4.2). */
interface OriginalTransform {
  /** The raw `transform` attribute value at gesture start; `null` when absent (preview reverts by removing the attribute). */
  transform: string | null;
  parts: TransformParts;
}

interface MoveGesture {
  kind: "move";
  ids: string[];
  originals: Map<string, OriginalTransform>;
  startUser: { x: number; y: number };
  lastDelta: { dx: number; dy: number };
}

interface MarqueeGesture {
  kind: "marquee";
  startClient: { x: number; y: number };
}

/**
 * A four-corner handle drag (NOOP-90/T2 §4.2, extending the original
 * uniform-only "Scale handles"). Two sub-paths share one gesture object,
 * chosen live every frame by the current Shift state (`updateScaleGesture`)
 * — Figma-style continuous toggling, not a choice locked in at gesture
 * start, since the runtime's `gesture-start` message carries no modifiers
 * to decide with anyway:
 *
 *  - **uniform** (Shift held, or `forceUniform`): send `element scale`,
 *    same math as before — `origin` (the element's own local origin, its
 *    matrix's own translate) lives in the element's PARENT coordinate
 *    space, and `startUser`/every subsequent point is mapped into that
 *    space via `parentInverse` before being compared against `origin`.
 *
 *  - **non-uniform** (the default, decision 4): send `element resize`.
 *    `localBox`/`anchorLocal` are computed with the element's OWN
 *    transform factored out (`invertMatrix(element.matrix)` composed as
 *    the sole "ancestor", the same trick `packages/core`'s own
 *    `resizeOneTarget` uses) — the fixed corner (opposite the dragged
 *    handle) in that local frame never moves as long as native geometry is
 *    scaled about the local origin, which is exactly what the live preview
 *    below does (a temporary non-uniform `scale(sx sy)` on the transform —
 *    visually identical to the real command's native-attribute resize, and
 *    the ONLY way to preview a size change through the existing
 *    `{command:"preview", items:[{id,transform}]}` protocol, which never
 *    changes native attributes). `fullInverse` maps a top-level user point
 *    into that same local frame, so a live pointer position becomes a
 *    local-frame corner comparable against `anchorLocal`. `null` when the
 *    element's local box could not be computed at gesture start (an
 *    unmeasurable `<text>`, a degenerate ancestor chain) — `forceUniform`
 *    is then also true, so the non-uniform path is never reached.
 *
 * `original`/`originalMatrix` — the element's own transform decomposed,
 * and its raw `Matrix`, both captured once at gesture start — are shared by
 * both sub-paths; `originalMatrix`'s linear part (no translation) is what
 * carries a local anchor-preserving delta into the parent frame for the
 * resize path, the same computation `resizeOneTarget` does server-side.
 */
interface ScaleGesture {
  kind: "scale";
  id: string;
  corner: "nw" | "ne" | "sw" | "se";
  original: OriginalTransform;
  originalMatrix: Matrix;
  /** True when the target (or, for a group, any descendant) contains a `<text>`/`<circle>`/`<path>` primitive — none has a non-uniform representation (core's `element resize` rejects all three), so the non-uniform path is never offered regardless of Shift. */
  forceUniform: boolean;
  origin: { x: number; y: number };
  startUser: { x: number; y: number };
  parentInverse: Matrix;
  localBox: Rect | null;
  /** The FIXED corner (opposite the dragged handle) in the element's own local frame, from the gesture-start `localBox`. */
  anchorLocal: { x: number; y: number };
  fullInverse: Matrix | null;
  /** Which sub-path actually produced the last applied preview — read by `endScaleGesture` to decide which command to send, since the trailing `gesture-end` message carries no modifiers of its own. */
  lastMode: "scale" | "resize";
  lastFactor: number;
  lastWidth: number;
  lastHeight: number;
}

/**
 * Rotation anchored at the element's own local origin, tracking a
 * continuously-unwrapped angle so a multi-revolution drag is not clamped to
 * ±180° (§4.2-follow-up "Rotate handle"). Same parent-coordinate-space
 * reasoning as `ScaleGesture` above — `origin` is in the element's parent
 * space, and every pointer point is mapped into that space via
 * `parentInverse` before its angle is measured.
 */
interface RotateGesture {
  kind: "rotate";
  id: string;
  original: OriginalTransform;
  origin: { x: number; y: number };
  /** Maps a top-level user-unit point into the element's parent coordinate space; the inverse of the composed ancestor chain (`entry.ancestors`) captured at gesture start. */
  parentInverse: Matrix;
  /** The raw (wrapped, -180..180) angle, in degrees, as of the last processed point — used to unwrap the next frame's delta. */
  lastAngleDeg: number;
  /** Sum of every frame's unwrapped angle delta so far, in degrees — can exceed ±360 across a multi-revolution drag. */
  cumulativeDeltaDeg: number;
}

/**
 * Textbox mid-edge width drag (§4.4). The command this ends in
 * (`textbox width`) accepts only a width, never a position — so unlike a
 * typical "drag the left edge" handle, the container's own `transform`
 * never moves; only the declared width changes, and the box's local
 * origin (its top-left corner, per `textBounds`'s own contract) stays
 * exactly where it started regardless of which handle is dragged. See the
 * known risks and unhandled cases for what this means for the LEFT handle's own
 * on-screen position during the drag.
 */
/**
 * Textbox mid-edge width drag: no font is fetched
 * any more — the drag only ever touches `data-slidra-text-width`, never the
 * `<text>` content (the runtime's `selectionClientRect` computes the
 * live-previewed box from the element's own unchanged bbox + this width,
 * see selection-runtime.js), so there is nothing left to measure.
 */
interface TextboxWidthGesture {
  kind: "textbox-width";
  id: string;
  handle: "left" | "right";
  originalWidth: number;
  originalTransform: string | null;
  startUserX: number;
  lastWidth: number;
}

type ActiveGesture = MoveGesture | MarqueeGesture | ScaleGesture | RotateGesture | TextboxWidthGesture;

/**
 * In-place text editing (NOOP-91/#70 US1, T5). Unlike `ActiveGesture`, this
 * is not driven by pointer coordinates — the runtime's hidden `<textarea>`
 * is the source of truth for the current string, and `currentText` here
 * only mirrors its last-reported value (`text-edit-input`) so
 * `commitTextEdit()` has something to diff against `originalText` and to
 * send. Exactly one of these exists at a time, independent of
 * `activeGesture` (a drag can never start while editing — see the runtime's
 * own editingId guard).
 */
interface TextEditState {
  id: string;
  slidePath: string;
  originalText: string;
  currentText: string;
}

/** Snap threshold in screen px, converted to user units per-viewport at drag time (assumption noted in the PR body). */
const SNAP_THRESHOLD_PX = 8;

/** Minimum interval between `POST /api/editing/begin` lease renewals fired from `gesture-move`. Well under `HUMAN_LEASE_MAX_MS` (5000ms, editing-lock.ts) so a drag longer than one interval never lets the lease lapse. */
const HUMAN_RENEW_THROTTLE_MS = 2000;

/** Rounds like `formatTransform`'s own 4-decimal rule, for the "did anything actually move/scale/rotate/resize" check. */
function roundsToZero(value: number): boolean {
  return Number(value.toFixed(4)) === 0;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Flattens a slide model into id -> {element, ancestor matrix chain (excluding the element's own matrix)}, recursing into groups. */
function flattenElements(
  elements: readonly SlideElement[],
  ancestors: readonly Matrix[],
  ancestorIds: readonly string[],
  out: Map<string, { element: SlideElement; ancestors: Matrix[]; ancestorIds: string[] }>,
): void {
  for (const element of elements) {
    out.set(element.id, { element, ancestors: [...ancestors], ancestorIds: [...ancestorIds] });
    if (element.kind === "group") {
      flattenElements(element.children, [...ancestors, element.matrix], [...ancestorIds, element.id], out);
    }
  }
}

/** Every id inside `element`'s own subtree, `element.id` itself included — used to keep a dragged group's own descendants out of its snap-candidate set (see `updateMoveGesture`'s exclusion set). */
function subtreeIds(element: SlideElement, out: Set<string>): void {
  out.add(element.id);
  for (const child of element.children) subtreeIds(child, out);
}

/** True when `element` (or, recursively for a group, any descendant) contains a `<text>`, `<circle>`, or `<path>` primitive — none has a non-uniform representation (`packages/core`'s `element resize` rejects all three; ADR-0012's "compound" holds several primitives, so it is checked one by one). Used by the four-corner handle to decide whether the non-uniform resize path applies at all, regardless of Shift. */
function subtreeForcesUniformScale(element: SlideElement): boolean {
  if (element.kind === "group") return element.children.some(subtreeForcesUniformScale);
  if (element.kind === "text" || element.kind === "circle" || element.kind === "path") return true;
  // A table scales through its container transform (see element-edit.ts), so a non-uniform factor would distort every glyph in it.
  if (element.kind === "table") return true;
  if (element.kind === "compound") {
    return element.primitives.some((primitive) => primitive.tag === "text" || primitive.tag === "circle" || primitive.tag === "path");
  }
  return false;
}

const OPPOSITE_CORNER: Record<"nw" | "ne" | "sw" | "se", "nw" | "ne" | "sw" | "se"> = {
  nw: "se",
  ne: "sw",
  sw: "ne",
  se: "nw",
};

/** The named corner of `box` — "nw" is `(box.x, box.y)`, "se" is the opposite corner, etc. Same formula as `packages/core`'s own `anchorCorner` (element-edit.ts), duplicated here because this module cannot import a Node-only core module and the formula is three lines. */
function cornerPoint(corner: "nw" | "ne" | "sw" | "se", box: Rect): { x: number; y: number } {
  return {
    x: corner === "ne" || corner === "se" ? box.x + box.width : box.x,
    y: corner === "sw" || corner === "se" ? box.y + box.height : box.y,
  };
}

export type { Viewport, OriginalTransform, MoveGesture, MarqueeGesture, ScaleGesture, RotateGesture, TextboxWidthGesture, ActiveGesture, TextEditState };
export { SNAP_THRESHOLD_PX, HUMAN_RENEW_THROTTLE_MS, roundsToZero, rectsIntersect, flattenElements, subtreeIds, subtreeForcesUniformScale, OPPOSITE_CORNER, cornerPoint };
