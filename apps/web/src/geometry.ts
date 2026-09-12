/**
 * SVG transform maths and drag-snap ("貼齊") calculation — the web's own
 * copy of core's geometry pure matrix/snap functions (F8,
 * NOOP-289 決定 G1). The browser no longer has a bundled font-metrics
 * engine to compute an element's bounding box from its parsed model, so
 * `elementBounds` is NOT ported: bounds now come from the runtime's own
 * `getBBox()`/`getCTM()` (real rendered geometry), reported over
 * `postMessage` — see `canvas.ts`'s `element-bounds` handling. Everything
 * below this line is unchanged pure math, ported verbatim from core.
 */

/** SVG's 2×3 affine matrix, in the same column order as `matrix(a b c d e f)`. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const DEG_TO_RAD = Math.PI / 180;

/** outer ∘ inner: applies `inner` first, matching `<g transform=outer><g transform=inner>`. */
export function multiplyMatrix(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

/** Multiplies a root-to-leaf container chain. An empty chain is IDENTITY. */
export function composeMatrices(chain: readonly Matrix[]): Matrix {
  let result = IDENTITY;
  for (const matrix of chain) {
    result = multiplyMatrix(result, matrix);
  }
  return result;
}

export function applyMatrixToPoint(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Inverse matrix. A degenerate matrix (zero determinant) throws. */
export function invertMatrix(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) {
    throw new Error("transform 無法反轉：矩陣的行列式為 0");
  }
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export interface TransformParts {
  translateX: number;
  translateY: number;
  /** Degrees, same unit and sign convention as SVG's `rotate()` (positive is clockwise). */
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/**
 * Splits a matrix into translate / rotate / scale.
 *
 * A matrix carrying skew (its two basis vectors are not perpendicular) has
 * no meaning in this model, so it throws rather than reporting a rotation
 * and scale that would not reproduce it.
 */
export function decomposeMatrix(m: Matrix): TransformParts {
  const scaleX = Math.hypot(m.a, m.b);
  const determinant = m.a * m.d - m.b * m.c;
  if (scaleX === 0 || determinant === 0) {
    throw new Error("transform 無法拆解：矩陣已退化（縮放為 0）");
  }
  const scaleYRaw = Math.hypot(m.c, m.d);
  const dot = m.a * m.c + m.b * m.d;
  if (Math.abs(dot) > 1e-9 * scaleX * scaleYRaw) {
    throw new Error("transform 無法拆解：矩陣含有傾斜（skew），這個模型沒有傾斜的語意");
  }
  return {
    translateX: m.e,
    translateY: m.f,
    rotation: Math.atan2(m.b, m.a) / DEG_TO_RAD,
    scaleX,
    scaleY: determinant < 0 ? -scaleYRaw : scaleYRaw,
  };
}

/**
 * Rounds to 4 decimal places and drops trailing zeros — the same
 * campaign-wide precision every command that writes a `transform` uses, so
 * this side's preview never disagrees with the CLI's own formatting.
 */
function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(4));
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * Serializes parts back into a transform-list, e.g.
 * "translate(640 330) rotate(-15)". Segments sitting at their default
 * value are omitted, and an all-default parts object yields the empty
 * string.
 */
export function formatTransform(parts: TransformParts): string {
  const segments: string[] = [];
  const tx = formatNumber(parts.translateX);
  const ty = formatNumber(parts.translateY);
  if (tx !== "0" || ty !== "0") segments.push(`translate(${tx} ${ty})`);
  const rotation = formatNumber(parts.rotation);
  if (rotation !== "0") segments.push(`rotate(${rotation})`);
  const sx = formatNumber(parts.scaleX);
  const sy = formatNumber(parts.scaleY);
  if (sx !== "1" || sy !== "1") segments.push(`scale(${sx} ${sy})`);
  return segments.join(" ");
}

/** The axis-aligned box around `r`'s four corners after `m` is applied. */
export function transformRect(m: Matrix, r: Rect): Rect {
  const corners: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x, y: r.y + r.height },
    { x: r.x + r.width, y: r.y + r.height },
  ].map((corner) => applyMatrixToPoint(m, corner));
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// --- 貼齊（智慧輔助線）, NOOP-91 §4.6 — pure, unchanged from core ---

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
  /** The dragged element's bounding box at the proposed position (already offset by the raw drag delta). */
  moving: Rect;
  /** Everything the drag may snap against; the caller excludes the dragged element itself. */
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
    throw new Error(`貼齊計算收到非有限數字：${what}`);
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
 * Best correction on ONE axis. Candidates in the order given, each
 * contributing its three lines, and only then the canvas centre line — a
 * later hit replaces the current best only when STRICTLY closer, so the
 * first one found wins every tie.
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
 * edge, or with the canvas's own centre lines. The two axes are computed
 * completely independently.
 */
export function snapTranslation(input: SnapInput): SnapResult {
  const { moving, candidates, canvas, threshold } = input;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`貼齊半徑必須是大於 0 的有限數字：${threshold}`);
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
  verticalLines.push(canvas.width / 2);
  horizontalLines.push(canvas.height / 2);

  const vertical = bestOnAxis(moving.x, moving.width, verticalLines, threshold);
  const horizontal = bestOnAxis(moving.y, moving.height, horizontalLines, threshold);

  const guides: SnapGuide[] = [];
  if (vertical) guides.push({ orientation: "v", position: vertical.position });
  if (horizontal) guides.push({ orientation: "h", position: horizontal.position });

  return { dx: vertical?.delta ?? 0, dy: horizontal?.delta ?? 0, guides };
}
