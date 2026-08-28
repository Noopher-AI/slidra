import { CoMotionError } from "../errors.js";
import type { SlideElement, SlidePrimitive } from "../slide/format.js";
import { measureTextWidth, type FontMetrics } from "../text-metrics.js";
import {
  applyMatrixToPoint,
  composeMatrices,
  multiplyMatrix,
  type Matrix,
  type Point,
} from "./transform.js";

/**
 * Bounding boxes. Together with `transform.ts` this is the whole of
 * "where is this element, and how big is it" — one implementation, shared
 * by the CLI and (once #76 wires the front end up to core) the editor's
 * live preview, so the two can never compute different answers.
 *
 * ADR-0012, as ruled for this campaign (軍令): conversion wraps, it never
 * hoists a primitive's native coordinates into the container. So an
 * element's absolute geometry is always
 *   container-chain matrix ∘ the primitive's own native geometry.
 *
 * No Node built-in imports.
 */

/**
 * Nesting limit for a container chain. A guard against a maliciously deep
 * slide blowing the call stack (ADR-0010: slide content is untrusted).
 * `slide/format.ts` re-exports this so the compliance check and this walk
 * can never disagree about the limit.
 */
export const MAX_CONTAINER_DEPTH = 64;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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

export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) {
    throw new CoMotionError("無法計算邊界框：沒有任何矩形可以聯集");
  }
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Reads a numeric primitive attribute. A missing attribute falls back to
 * `fallback` only where SVG itself defines that default (e.g. `<rect>`'s
 * `x` defaults to 0) — pass `null` for attributes with no default, and the
 * absence is reported as an error instead.
 *
 * Percentages are rejected outright: a percentage is relative to the
 * viewport, which has no single answer inside a container chain.
 */
function numberAttr(
  primitive: SlidePrimitive,
  name: string,
  fallback: number | null,
): number {
  const raw = primitive.attrs.get(name);
  if (raw === undefined || raw.trim() === "") {
    if (fallback === null) {
      throw new CoMotionError(`<${primitive.tag}> 缺少計算邊界框需要的屬性：${name}`);
    }
    return fallback;
  }
  const text = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    throw new CoMotionError(
      `<${primitive.tag}> 的屬性 ${name} 不是純數字：${text}（百分比與單位在容器鏈裡沒有唯一答案）`,
    );
  }
  return Number(text);
}

export interface PrimitiveBoundsOptions {
  /** Required to box a `<text>` primitive; every other tag ignores it. */
  readonly fontBook?: ReadonlyMap<string, FontMetrics>;
  /**
   * The declared width of the text box the primitive's container names
   * (`data-comot-text-width`, #76) — present only when the `<text>`
   * belongs to a text box, absent for the plain, legacy `<text>` shape.
   */
  readonly textWidth?: number;
}

/**
 * The bounding box of one primitive, in the coordinate system the
 * primitive itself lives in (i.e. before any container transform).
 *
 * `<text>` needs font metrics (`options.fontBook`, #76) — see
 * `textPrimitiveBounds` below for its two shapes.
 */
export function primitiveBounds(primitive: SlidePrimitive, options: PrimitiveBoundsOptions = {}): Rect {
  switch (primitive.tag) {
    case "rect":
    case "image": {
      const x = numberAttr(primitive, "x", 0);
      const y = numberAttr(primitive, "y", 0);
      return {
        x,
        y,
        width: numberAttr(primitive, "width", null),
        height: numberAttr(primitive, "height", null),
      };
    }
    case "circle": {
      const cx = numberAttr(primitive, "cx", 0);
      const cy = numberAttr(primitive, "cy", 0);
      const r = numberAttr(primitive, "r", null);
      return { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r };
    }
    case "ellipse": {
      const cx = numberAttr(primitive, "cx", 0);
      const cy = numberAttr(primitive, "cy", 0);
      const rx = numberAttr(primitive, "rx", null);
      const ry = numberAttr(primitive, "ry", null);
      return { x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry };
    }
    case "line": {
      const x1 = numberAttr(primitive, "x1", 0);
      const y1 = numberAttr(primitive, "y1", 0);
      const x2 = numberAttr(primitive, "x2", 0);
      const y2 = numberAttr(primitive, "y2", 0);
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }
    case "path": {
      const d = primitive.attrs.get("d");
      if (d === undefined) {
        throw new CoMotionError("<path> 缺少計算邊界框需要的屬性：d");
      }
      return pathBounds(d);
    }
    case "text":
      return textPrimitiveBounds(primitive, options);
    default:
      throw new CoMotionError(`無法計算邊界框：<${primitive.tag}> 不是合法圖元`);
  }
}

/**
 * Reads a required string primitive attribute (font-family): SVG defines
 * no default for it, so a missing value is an error, never a guessed
 * fallback — the exact failure #71 exists to remove.
 */
function requiredStringAttr(primitive: SlidePrimitive, name: string): string {
  const raw = primitive.attrs.get(name);
  if (raw === undefined || raw.trim() === "") {
    throw new CoMotionError(`<${primitive.tag}> 缺少計算邊界框需要的屬性：${name}`);
  }
  return raw;
}

/**
 * `<text>`'s bounding box, one of two shapes (#76, DEBT1):
 *
 * - A **text box** (`options.textWidth` set, from the container's
 *   `data-comot-text-width`): `{x: 0, y: 0, width: <declared>, height:
 *   lines * lineHeight}` — deliberately the declared width, not the
 *   widest baked-in line, so dragging the side handle moves the box's edge
 *   to where the author put it. `lines` is the primitive's `tspanCount`
 *   (structural — no re-measuring or re-wrapping needed, since the wrap is
 *   already baked into the file, exactly #76's point).
 * - A **plain `<text>`** (the legacy shape, e.g. every `<text>` in
 *   `demo/slides/`): the content is measured, then positioned by
 *   `text-anchor` (`start` → `x`, `middle` → `x - w/2`, `end` → `x - w`),
 *   `y = baseline - ascent`, `height = ascent - descent` (hhea).
 *
 * `font-size` missing defaults to 16 (SVG's own default, the same rule
 * `numberAttr` already applies). `font-family` missing is an error — SVG
 * defines no default, and guessing one is exactly #71's failure mode.
 */
function textPrimitiveBounds(primitive: SlidePrimitive, options: PrimitiveBoundsOptions): Rect {
  if (!options.fontBook) {
    throw new CoMotionError("計算 <text> 的邊界框需要字型（fontBook）");
  }
  const fontFamily = requiredStringAttr(primitive, "font-family");
  const fontSize = numberAttr(primitive, "font-size", 16);
  const font = options.fontBook.get(fontFamily);
  if (!font) {
    throw new CoMotionError(`簡報未內嵌字型：${fontFamily}`);
  }
  const anchor = primitive.attrs.get("text-anchor");

  if (options.textWidth !== undefined) {
    if (anchor !== undefined && anchor !== "start") {
      throw new CoMotionError("文字框的 <text> 不可使用 text-anchor（尚未支援對齊）");
    }
    // hhea-derived, matching text/wrap.ts's own line-height formula exactly
    // — see that module's comment for why nothing multiplies it yet.
    const lineHeight = ((font.ascender - font.descender + font.lineGap) / font.unitsPerEm) * fontSize;
    const lines = Math.max(primitive.tspanCount, 1);
    return { x: 0, y: 0, width: options.textWidth, height: lines * lineHeight };
  }

  const width = measureTextWidth(font, primitive.text, fontSize);
  const ascent = (font.ascender / font.unitsPerEm) * fontSize;
  const descent = (font.descender / font.unitsPerEm) * fontSize;
  const x = numberAttr(primitive, "x", 0);
  const y = numberAttr(primitive, "y", 0);
  let boxX: number;
  switch (anchor ?? "start") {
    case "start":
      boxX = x;
      break;
    case "middle":
      boxX = x - width / 2;
      break;
    case "end":
      boxX = x - width;
      break;
    default:
      throw new CoMotionError(`<text> 的 text-anchor 不是合法值：${anchor}`);
  }
  return { x: boxX, y: y - ascent, width, height: ascent - descent };
}

/**
 * Bounding box of a `<path>`'s `d`, exact for every command it supports:
 * straight segments contribute their endpoints, and Bézier segments
 * contribute the real extremes of their curve (the roots of the derivative
 * inside 0 < t < 1), not just their control points — a control-point box is
 * always too large, which would put an alignment command visibly off.
 *
 * Elliptical arcs (`A`/`a`) throw. Computing their extremes exactly means
 * converting endpoint parameterisation to centre parameterisation, and no
 * ticket in this campaign needed it yet; an approximation here would be a
 * wrong answer silently returned, which is the one thing this codebase
 * does not do. #72's report records this gap.
 */
export function pathBounds(d: string): Rect {
  const tokens = tokenizePathData(d);
  const xs: number[] = [];
  const ys: number[] = [];
  const note = (x: number, y: number): void => {
    xs.push(x);
    ys.push(y);
  };

  let index = 0;
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let command = "";
  /** Reflection of the previous cubic's second control point, for `S`/`s`. */
  let lastCubicControl: Point | null = null;
  /** Reflection of the previous quadratic's control point, for `T`/`t`. */
  let lastQuadControl: Point | null = null;

  const number = (): number => {
    const token = tokens[index++];
    if (token === undefined || typeof token !== "number") {
      throw new CoMotionError(`<path> 的 d 語法錯誤：${command} 指令的參數不足`);
    }
    return token;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (typeof token === "string") {
      command = token;
      index++;
    } else if (command === "") {
      throw new CoMotionError("<path> 的 d 語法錯誤：第一個指令必須是 M 或 m");
    } else if (command === "M") {
      command = "L";
    } else if (command === "m") {
      command = "l";
    }

    const relative = command === command.toLowerCase();
    const base = relative ? current : { x: 0, y: 0 };

    switch (command.toUpperCase()) {
      case "M": {
        const x = base.x + number();
        const y = base.y + number();
        current = { x, y };
        subpathStart = current;
        note(x, y);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "L": {
        const x = base.x + number();
        const y = base.y + number();
        current = { x, y };
        note(x, y);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "H": {
        const x = base.x + number();
        current = { x, y: current.y };
        note(x, current.y);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "V": {
        const y = base.y + number();
        current = { x: current.x, y };
        note(current.x, y);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "C":
      case "S": {
        let c1: Point;
        if (command.toUpperCase() === "C") {
          c1 = { x: base.x + number(), y: base.y + number() };
        } else {
          c1 = lastCubicControl
            ? { x: 2 * current.x - lastCubicControl.x, y: 2 * current.y - lastCubicControl.y }
            : current;
        }
        const c2 = { x: base.x + number(), y: base.y + number() };
        const end = { x: base.x + number(), y: base.y + number() };
        for (const value of cubicExtremes(current.x, c1.x, c2.x, end.x)) xs.push(value);
        for (const value of cubicExtremes(current.y, c1.y, c2.y, end.y)) ys.push(value);
        current = end;
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case "Q":
      case "T": {
        let control: Point;
        if (command.toUpperCase() === "Q") {
          control = { x: base.x + number(), y: base.y + number() };
        } else {
          control = lastQuadControl
            ? { x: 2 * current.x - lastQuadControl.x, y: 2 * current.y - lastQuadControl.y }
            : current;
        }
        const end = { x: base.x + number(), y: base.y + number() };
        for (const value of quadraticExtremes(current.x, control.x, end.x)) xs.push(value);
        for (const value of quadraticExtremes(current.y, control.y, end.y)) ys.push(value);
        current = end;
        lastQuadControl = control;
        lastCubicControl = null;
        break;
      }
      case "Z": {
        // Z takes no arguments, so a number here would consume nothing and
        // spin this loop forever. Report it instead.
        if (typeof tokens[index] === "number") {
          throw new CoMotionError("<path> 的 d 語法錯誤：Z 指令後面不能接數字");
        }
        current = subpathStart;
        note(current.x, current.y);
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case "A":
        throw new CoMotionError("尚無法計算含橢圓弧（A/a 指令）的 <path> 邊界框");
      default:
        throw new CoMotionError(`<path> 的 d 語法錯誤：不支援的指令 ${command}`);
    }
  }

  if (xs.length === 0) {
    throw new CoMotionError("<path> 的 d 沒有任何座標，無法計算邊界框");
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Splits path data into command letters and numbers, throwing on anything else. */
function tokenizePathData(d: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  const pattern = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)/gy;
  let position = 0;
  while (position < d.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(d);
    if (!match) {
      throw new CoMotionError(`<path> 的 d 語法錯誤：無法解析「${d.slice(position, position + 12)}」`);
    }
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(Number(match[2]));
    position = pattern.lastIndex;
  }
  return tokens;
}

/** Endpoints plus every real extreme of a cubic Bézier on one axis. */
function cubicExtremes(p0: number, p1: number, p2: number, p3: number): number[] {
  const values = [p0, p3];
  // B'(t) = 3[(-p0+3p1-3p2+p3)t² + (2p0-4p1+2p2)t + (-p0+p1)]
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * p0 - 4 * p1 + 2 * p2;
  const c = -p0 + p1;
  for (const t of solveQuadratic(a, b, c)) {
    if (t > 0 && t < 1) {
      const u = 1 - t;
      values.push(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
    }
  }
  return values;
}

/** Endpoints plus the single real extreme of a quadratic Bézier on one axis. */
function quadraticExtremes(p0: number, p1: number, p2: number): number[] {
  const values = [p0, p2];
  const denominator = p0 - 2 * p1 + p2;
  if (denominator !== 0) {
    const t = (p0 - p1) / denominator;
    if (t > 0 && t < 1) {
      const u = 1 - t;
      values.push(u * u * p0 + 2 * u * t * p1 + t * t * p2);
    }
  }
  return values;
}

function solveQuadratic(a: number, b: number, c: number): number[] {
  if (a === 0) {
    return b === 0 ? [] : [-c / b];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

export interface ElementBoundsOptions {
  /** Container matrices from the slide root down to (but excluding) this element. */
  ancestors?: readonly Matrix[];
  /** Required to box an element containing a `<text>` primitive (#76). */
  fontBook?: ReadonlyMap<string, FontMetrics>;
}

/**
 * The element's axis-aligned bounding box in the slide's coordinate system:
 * the container chain's matrix applied to each primitive's native geometry,
 * or the union of the child elements' boxes for a group.
 */
export function elementBounds(element: SlideElement, options: ElementBoundsOptions = {}): Rect {
  const chain = composeMatrices(options.ancestors ?? []);
  return boundsWithin(element, chain, 1, options.fontBook);
}

function boundsWithin(
  element: SlideElement,
  ancestorMatrix: Matrix,
  depth: number,
  fontBook: ReadonlyMap<string, FontMetrics> | undefined,
): Rect {
  if (depth > MAX_CONTAINER_DEPTH) {
    throw new CoMotionError(`容器巢狀超過 ${MAX_CONTAINER_DEPTH} 層，無法計算邊界框`);
  }
  const matrix = multiplyMatrix(ancestorMatrix, element.matrix);
  if (element.kind === "group") {
    if (element.children.length === 0) {
      throw new CoMotionError(`群組 ${element.id} 裡沒有任何子元素，沒有邊界框`);
    }
    return unionRects(element.children.map((child) => boundsWithin(child, matrix, depth + 1, fontBook)));
  }
  if (element.primitives.length === 0) {
    throw new CoMotionError(`元素 ${element.id} 裡沒有任何圖元，沒有邊界框`);
  }
  return unionRects(
    element.primitives.map((primitive) =>
      transformRect(matrix, primitiveBounds(primitive, { fontBook, textWidth: element.textWidth ?? undefined })),
    ),
  );
}

/** The element's top-left corner in slide coordinates — the `(x, y)` of `elementBounds`. */
export function absolutePosition(element: SlideElement, options: ElementBoundsOptions = {}): Point {
  const bounds = elementBounds(element, options);
  return { x: bounds.x, y: bounds.y };
}
