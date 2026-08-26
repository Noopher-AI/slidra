import { CoMotionError } from "../errors.js";
import type { FontBook, TextStyle } from "../font/metrics.js";

/**
 * Computes where a text box's content breaks into lines, at authoring
 * time — the break result is baked into the SVG, never recomputed by a
 * viewer (#76, AC2). No Node built-in import, not even transitively: the
 * e2e identity proof loads this exact compiled module into a real browser
 * (AC5), so a `node:` import anywhere in this file's dependency graph would
 * make that load fail outright.
 *
 * Every width, ascent and line-height number here comes from `FontBook`
 * (`../font/metrics.js`) — the one measurement implementation (軍令 1).
 * This module never re-measures or estimates a width on its own.
 */

export interface WrapOptions {
  /** Box width in user units. Finite, > 0. */
  readonly width: number;
  readonly style: TextStyle;
  readonly book: FontBook;
}

export interface WrappedLine {
  readonly text: string;
  /** Baseline y relative to the box's top-left corner. */
  readonly y: number;
  /** Measured advance width of this line. */
  readonly width: number;
}

export interface WrappedText {
  readonly lines: readonly WrappedLine[];
  readonly lineHeight: number;
  readonly ascent: number;
  /** lines.length * lineHeight */
  readonly height: number;
}

// CJK-ish code point ranges (§1 of the plan): CJK symbols/punctuation,
// hiragana/katakana, CJK unified ideographs (BMP and extension A), hangul
// syllables, CJK compatibility ideographs, halfwidth/fullwidth forms, and
// the supplementary-plane CJK unified ideographs extension B.
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xff60],
  [0x20000, 0x2a6df],
];

function isCjk(codePoint: number): boolean {
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * Closing/trailing punctuation a line must never end immediately before,
 * and opening punctuation a line must never end immediately after. This
 * set is convention-derived, not drawn from a specification or an existing
 * table in this repo (there is none) — it is expected to be corrected at
 * the margins (ellipsis, dashes, small kana) as real content surfaces
 * gaps. One named constant each, so a correction touches exactly one place
 * (W1-R8).
 */
export const NO_BREAK_BEFORE = new Set(
  Array.from("」』）］｝〉》、，。．！？：；・…〜ー", (ch) => ch.codePointAt(0) as number),
);
export const NO_BREAK_AFTER = new Set(
  Array.from("「『（［｛〈《", (ch) => ch.codePointAt(0) as number),
);

const SPACE = 0x0020;

/**
 * Whether a line is permitted to break between `previous` and `next`
 * (adjacent code points, `previous` immediately before `next`). Order
 * matters: the punctuation rules are checked first so they override the
 * space/CJK rules — e.g. a break is never allowed right before `」` even
 * when the previous code point is CJK and would otherwise permit it.
 */
export function breakAllowedBetween(previous: number, next: number): boolean {
  if (NO_BREAK_BEFORE.has(next)) return false;
  if (NO_BREAK_AFTER.has(previous)) return false;
  if (previous === SPACE) return true;
  if (isCjk(previous) || isCjk(next)) return true;
  return false;
}

function assertWidth(width: number): void {
  if (!Number.isFinite(width) || width <= 0) {
    throw new CoMotionError("文字框寬度必須是大於 0 的數字");
  }
}

/**
 * Greedy first-fit line breaking, by code point (`Array.from`, matching
 * `FontBook.measureText`'s own iteration, so surrogate pairs need no
 * special case).
 *
 * Never deletes a character: a break after a space leaves the space at the
 * end of the previous line rather than dropping it, which is what makes
 * `lines.map(l => l.text).join("")` reproduce the input byte for byte —
 * the invariant the whole text-box data model rests on (§1 step 5).
 *
 * A single code point wider than `width` gets its own line, and that line
 * is the one case allowed to exceed `width` (an error here would make
 * "drag the box narrower" fail mid-drag; CSS's `overflow-wrap: anywhere`
 * is the least surprising answer). Every other emergency break — an
 * unbroken run wider than the box, e.g. one long Latin word — breaks
 * immediately before the code point that would overflow, so those lines
 * never exceed `width`.
 */
export function wrapText(text: string, options: WrapOptions): WrappedText {
  const { width, style, book } = options;
  assertWidth(width);

  const face = book.faceFor(style);
  const ascent = (face.ascender / face.unitsPerEm) * style.fontSize;
  // hhea-derived line height (ascender - descender + lineGap), per em. No
  // `line-height` concept exists anywhere else in the slide format yet
  // (W1-R7); a later 行距 feature will have to decide whether it
  // multiplies this number or replaces it.
  const lineHeight =
    ((face.ascender - face.descender + face.lineGap) / face.unitsPerEm) * style.fontSize;

  const codePoints = Array.from(text, (ch) => ch.codePointAt(0) as number);
  // Measuring every code point up front means a bad character (a control
  // character, a missing glyph — see 軍令 2) throws before any line is
  // built, from the one place `assertMeasurable`/glyph lookup already live.
  const advances = codePoints.map((codePoint) => book.advanceOf(codePoint, style));

  if (codePoints.length === 0) {
    // One empty line, so the box still has a height and still round-trips
    // (`lines.map(l => l.text).join("") === ""`).
    return { lines: [{ text: "", y: ascent, width: 0 }], lineHeight, ascent, height: lineHeight };
  }

  const lines: WrappedLine[] = [];
  let start = 0;
  // Invariant: start < codePoints.length on every entry — the empty-text
  // case is handled above, so every iteration here has real text left to
  // place, and the loop cannot spin an extra, spurious empty final line
  // after the last real character is consumed.
  while (start < codePoints.length) {
    let accumulated = 0;
    /** Index right after the last code point of a permitted break, or -1. */
    let breakAt = -1;
    let breakWidth = 0;
    let cursor = start;
    while (cursor < codePoints.length) {
      const next = accumulated + advances[cursor];
      if (next > width) break;
      accumulated = next;
      if (
        cursor + 1 < codePoints.length &&
        breakAllowedBetween(codePoints[cursor], codePoints[cursor + 1])
      ) {
        breakAt = cursor + 1;
        breakWidth = accumulated;
      }
      cursor++;
    }

    if (cursor === codePoints.length) {
      // Everything from `start` fits on one final line.
      lines.push({
        text: codePointsToString(codePoints, start, cursor),
        y: ascent + lines.length * lineHeight,
        width: accumulated,
      });
      break;
    }

    if (cursor === start) {
      // The very first code point of this line is already wider than the
      // box on its own: it takes its own (overflowing) line.
      lines.push({
        text: codePointsToString(codePoints, start, start + 1),
        y: ascent + lines.length * lineHeight,
        width: advances[start],
      });
      start += 1;
      continue;
    }

    if (breakAt > start) {
      lines.push({
        text: codePointsToString(codePoints, start, breakAt),
        y: ascent + lines.length * lineHeight,
        width: breakWidth,
      });
      start = breakAt;
    } else {
      // No permitted break anywhere in this run: character-level
      // emergency break right before the code point that overflowed.
      lines.push({
        text: codePointsToString(codePoints, start, cursor),
        y: ascent + lines.length * lineHeight,
        width: accumulated,
      });
      start = cursor;
    }
  }

  return { lines, lineHeight, ascent, height: lines.length * lineHeight };
}

function codePointsToString(codePoints: readonly number[], from: number, to: number): string {
  return String.fromCodePoint(...codePoints.slice(from, to));
}
