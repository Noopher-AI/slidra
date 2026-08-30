import { CoMotionError } from "../errors.js";
import type { Rect } from "./bbox.js";

/**
 * 貼齊（智慧輔助線）的計算，NOOP-91 §4.6。
 *
 * This module only ever adjusts a translation that is about to be sent as
 * an `element move`. It creates no command, no flag and no data of its own,
 * and nothing here is ever written into a presentation — the guides it
 * returns are drawn on screen and thrown away when the gesture ends.
 *
 * No Node built-in imports: like the rest of `geometry/`, this has to run
 * inside the browser bundle (the front end is the only caller).
 */

export interface SnapCandidate {
  id: string;
  bounds: Rect;
}

export interface SnapGuide {
  /** `"h"` is a horizontal line (constant y); `"v"` is a vertical line (constant x). */
  orientation: "h" | "v";
  position: number;
}

export interface SnapInput {
  /**
   * The dragged element's bounding box AT THE PROPOSED POSITION — i.e. its
   * original bounds already offset by the raw drag delta. This module has
   * no way to see the raw delta itself, which is why the result below is a
   * correction rather than a replacement.
   */
  moving: Rect;
  /**
   * Everything the drag may snap against. The caller is responsible for
   * excluding the dragged element itself (§4.6); an element whose bounding
   * box could not be computed is simply left out.
   */
  candidates: readonly SnapCandidate[];
  canvas: { width: number; height: number };
  /** Snap radius in the same units as `moving`. Must be finite and > 0. */
  threshold: number;
}

export interface SnapResult {
  /** Correction to ADD to the raw drag delta on the x axis; 0 when nothing snapped. */
  dx: number;
  /** Correction to ADD to the raw drag delta on the y axis; 0 when nothing snapped. */
  dy: number;
  /** One guide per axis that actually snapped, vertical first. Empty when neither did. */
  guides: SnapGuide[];
}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new CoMotionError(`貼齊計算收到非有限數字：${what}`);
  }
}

function assertRect(rect: Rect, what: string): void {
  assertFinite(rect.x, `${what}.x`);
  assertFinite(rect.y, `${what}.y`);
  assertFinite(rect.width, `${what}.width`);
  assertFinite(rect.height, `${what}.height`);
}

/** The three snap lines one box contributes on one axis: near edge, centre, far edge. */
function edgesOf(start: number, size: number): readonly number[] {
  return [start, start + size / 2, start + size];
}

/**
 * Best correction on ONE axis.
 *
 * Enumeration order is the tie-break rule (§4.6: "距離相同時取 candidates
 * 的先後順序"): candidates in the order given, each contributing its three
 * lines, and only then the canvas centre line. A later hit replaces the
 * current best only when it is STRICTLY closer, so the first one found wins
 * every tie — including a tie between a candidate and the canvas.
 */
function bestOnAxis(
  movingStart: number,
  movingSize: number,
  targetLines: readonly number[],
  threshold: number,
): { delta: number; position: number } | null {
  const movingEdges = edgesOf(movingStart, movingSize);
  let best: { delta: number; position: number } | null = null;
  for (const line of targetLines) {
    for (const edge of movingEdges) {
      const delta = line - edge;
      if (Math.abs(delta) > threshold) continue;
      if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, position: line };
      }
    }
  }
  return best;
}

/**
 * Computes how far a proposed drag has to be nudged so the dragged box
 * lines up with a neighbour's left/centre/right (or top/centre/bottom)
 * edge, or with the canvas's own centre lines.
 *
 * The two axes are computed completely independently: a drag may snap
 * horizontally, vertically, both, or neither.
 *
 * A `threshold` that is not a finite number greater than 0 throws rather
 * than being treated as "no snapping" — silently doing nothing is exactly
 * the kind of repaired-input answer this codebase does not return.
 */
export function snapTranslation(input: SnapInput): SnapResult {
  const { moving, candidates, canvas, threshold } = input;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new CoMotionError(`貼齊半徑必須是大於 0 的有限數字：${threshold}`);
  }
  assertRect(moving, "moving");
  assertFinite(canvas.width, "canvas.width");
  assertFinite(canvas.height, "canvas.height");
  for (const candidate of candidates) {
    assertRect(candidate.bounds, `candidates[${candidate.id}].bounds`);
  }

  const verticalLines: number[] = [];
  const horizontalLines: number[] = [];
  for (const candidate of candidates) {
    verticalLines.push(...edgesOf(candidate.bounds.x, candidate.bounds.width));
    horizontalLines.push(...edgesOf(candidate.bounds.y, candidate.bounds.height));
  }
  // The canvas centre lines come last, so a candidate at exactly the same
  // distance wins the tie against them.
  verticalLines.push(canvas.width / 2);
  horizontalLines.push(canvas.height / 2);

  const vertical = bestOnAxis(moving.x, moving.width, verticalLines, threshold);
  const horizontal = bestOnAxis(moving.y, moving.height, horizontalLines, threshold);

  const guides: SnapGuide[] = [];
  if (vertical) guides.push({ orientation: "v", position: vertical.position });
  if (horizontal) guides.push({ orientation: "h", position: horizontal.position });

  return { dx: vertical?.delta ?? 0, dy: horizontal?.delta ?? 0, guides };
}
