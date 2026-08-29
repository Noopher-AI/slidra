import { CoMotionError } from "../errors.js";

/**
 * SVG transform maths. This module is the single implementation of
 * "where is this element, really" (ADR-0012: absolute coordinates come
 * from multiplying the container chain), shared by the CLI and, later, the
 * front end.
 *
 * It deliberately imports no Node built-in module — the whole module has to
 * stay runnable in a browser bundle, which is the reason the geometry
 * lives here rather than inside a Node-only command module.
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

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const DEG_TO_RAD = Math.PI / 180;

/** How many arguments each SVG transform function accepts (SVG 1.1 §7.4). */
const ARITY: Record<string, readonly number[]> = {
  matrix: [6],
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewX: [1],
  skewY: [1],
};

/**
 * Parses an SVG transform-list into a single matrix. `null`, `undefined`
 * and a whitespace-only string all yield IDENTITY: "this element has no
 * transform" is the common case, and making it the identity means it is
 * never a special case anywhere downstream.
 *
 * Anything it cannot make sense of — an unknown function name, the wrong
 * number of arguments, a non-numeric argument, an unclosed parenthesis —
 * throws instead of being skipped. A silently-dropped transform would
 * move the element, which is the one failure this module must never
 * produce quietly.
 */
export function parseTransform(value: string | null | undefined): Matrix {
  if (value === null || value === undefined) return IDENTITY;
  const text = value.trim();
  if (text === "") return IDENTITY;

  let result = IDENTITY;
  let i = 0;
  const isSeparator = (ch: string): boolean => ch === "," || /\s/.test(ch);

  while (i < text.length) {
    while (i < text.length && isSeparator(text[i])) i++;
    if (i >= text.length) break;

    const nameStart = i;
    while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    if (!name) {
      throw new CoMotionError(`transform 語法錯誤：無法解析函式名稱（${text}）`);
    }

    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "(") {
      throw new CoMotionError(`transform 語法錯誤：${name} 後面缺少 (`);
    }
    const close = text.indexOf(")", i);
    if (close === -1) {
      throw new CoMotionError(`transform 語法錯誤：${name} 的括號未封閉`);
    }
    const args = parseArguments(name, text.slice(i + 1, close));
    i = close + 1;

    result = multiplyMatrix(result, functionToMatrix(name, args));
  }

  return result;
}

function parseArguments(name: string, argsText: string): number[] {
  const arity = ARITY[name];
  if (!arity) {
    throw new CoMotionError(`不支援的 transform 函式：${name}`);
  }
  const tokens = argsText.split(/[\s,]+/).filter((token) => token.length > 0);
  const values = tokens.map((token) => {
    // Number() accepts "" and "0x10"; the explicit pattern keeps this to
    // the decimal-number syntax SVG actually defines.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
      throw new CoMotionError(`transform 語法錯誤：${name} 的參數不是數字（${token}）`);
    }
    return Number(token);
  });
  if (!arity.includes(values.length)) {
    throw new CoMotionError(
      `transform 語法錯誤：${name} 收到 ${values.length} 個參數，應為 ${arity.join(" 或 ")} 個`,
    );
  }
  return values;
}

function functionToMatrix(name: string, args: number[]): Matrix {
  switch (name) {
    case "matrix":
      return { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
    case "translate":
      return { a: 1, b: 0, c: 0, d: 1, e: args[0], f: args.length === 2 ? args[1] : 0 };
    case "scale": {
      const sx = args[0];
      const sy = args.length === 2 ? args[1] : sx;
      return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
    }
    case "rotate": {
      const radians = args[0] * DEG_TO_RAD;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (args.length === 1) return rotation;
      // rotate(angle cx cy) === translate(cx cy) rotate(angle) translate(-cx -cy)
      const [, cx, cy] = args;
      return multiplyMatrix(
        multiplyMatrix({ ...IDENTITY, e: cx, f: cy }, rotation),
        { ...IDENTITY, e: -cx, f: -cy },
      );
    }
    case "skewX":
      return { a: 1, b: 0, c: Math.tan(args[0] * DEG_TO_RAD), d: 1, e: 0, f: 0 };
    case "skewY":
      return { a: 1, b: Math.tan(args[0] * DEG_TO_RAD), c: 0, d: 1, e: 0, f: 0 };
    default:
      throw new CoMotionError(`不支援的 transform 函式：${name}`);
  }
}

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
    throw new CoMotionError("transform 無法反轉：矩陣的行列式為 0");
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
    throw new CoMotionError("transform 無法拆解：矩陣已退化（縮放為 0）");
  }
  // With no skew, (a b) and (c d) are perpendicular. Compare their dot
  // product against the magnitudes rather than against an absolute epsilon,
  // so the test means the same thing at any scale.
  const scaleYRaw = Math.hypot(m.c, m.d);
  const dot = m.a * m.c + m.b * m.d;
  if (Math.abs(dot) > 1e-9 * scaleX * scaleYRaw) {
    throw new CoMotionError("transform 無法拆解：矩陣含有傾斜（skew），這個模型沒有傾斜的語意");
  }
  return {
    translateX: m.e,
    translateY: m.f,
    rotation: Math.atan2(m.b, m.a) / DEG_TO_RAD,
    scaleX,
    // determinant < 0 means one axis is mirrored; hypot alone cannot see it.
    scaleY: determinant < 0 ? -scaleYRaw : scaleYRaw,
  };
}

/**
 * Rounds to 4 decimal places and drops trailing zeros. 4 places is the
 * campaign-wide precision for every command that writes a `transform`
 * (軍令): on a 1280-unit canvas it is far below one device pixel, and
 * fixing it in one place is what keeps two commands from writing the same
 * position differently.
 */
function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(4));
  // `-0` and `0` are the same position; only one of them should ever be written.
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * Serializes parts back into a transform-list, e.g.
 * "translate(640 330) rotate(-15)". Segments sitting at their default
 * value are omitted, and an all-default parts object yields the empty
 * string so the caller can decide to write no `transform` attribute at all
 * (ADR-0004: every byte of SVG is a per-turn token cost).
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
