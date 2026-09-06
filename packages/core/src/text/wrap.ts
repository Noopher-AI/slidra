import { CoMotionError } from "../errors.js";
import { measureTextWidth, type FontMetrics } from "../text-metrics.js";

/**
 * Computes where a text box's content breaks into lines, at authoring
 * time — the break result is baked into the SVG, never recomputed by a
 * viewer (#76, AC2). No Node built-in import, not even transitively: the
 * e2e identity proof loads this exact compiled module into a real browser
 * (AC5), so a `node:` import anywhere in this file's dependency graph would
 * make that load fail outright.
 *
 * Every width, ascent and line-height number here comes from
 * `measureTextWidth`/`FontMetrics` (`../text-metrics.js`, #98) — the one
 * measurement implementation (軍令 1). This module never re-measures or
 * estimates a width on its own, and never inspects glyph/cmap data
 * directly — every width, including one for a code point the font's cmap
 * doesn't cover, comes from calling `measureTextWidth` on a candidate
 * substring (see the loop in `wrapText` below).
 */

export interface WrapOptions {
  /** Box width in user units. Finite, > 0. */
  readonly width: number;
  readonly font: FontMetrics;
  /** User units (SVG px). Must be a finite number greater than 0; decimals are legal. */
  readonly fontSizePx: number;
  /** Horizontal alignment, baked into each line's `x`. Defaults to "left". */
  readonly align?: "left" | "center" | "right";
  /**
   * Per-paragraph left indent, in user units — paragraph `i` (0-based,
   * `text` split on `"\n"`) is wrapped at `width - indents[i]` and its
   * lines' `x` starts at `indents[i]`. Missing entries default to 0.
   */
  readonly indents?: readonly number[];
}

export interface WrappedLine {
  readonly text: string;
  /** Baseline y relative to the box's top-left corner. */
  readonly y: number;
  /** Measured advance width of this line. */
  readonly width: number;
  /** Baked-in horizontal position, from alignment + the line's paragraph indent. */
  readonly x: number;
  /**
   * True when this line ends because the source text had a `"\n"` there
   * (a hard break, not a wrap-induced break). The `\n` itself is never
   * part of any line's `text` — see the module header comment for why.
   */
  readonly hardBreak: boolean;
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

/** One paragraph's wrapped lines, before the caller assigns global `y`/`x`. */
interface WrappedParagraphLine {
  readonly text: string;
  readonly width: number;
}

/**
 * Greedy first-fit line breaking of one paragraph (no `"\n"` inside it), by
 * code point (`Array.from`, matching `measureTextWidth`'s own iteration, so
 * surrogate pairs need no special case).
 *
 * Never deletes a character: a break after a space leaves the space at the
 * end of the previous line rather than dropping it — see `wrapText`'s own
 * header comment for the round-trip invariant this feeds.
 *
 * A single code point wider than `width` gets its own line, and that line
 * is the one case allowed to exceed `width` (an error here would make
 * "drag the box narrower" fail mid-drag; CSS's `overflow-wrap: anywhere`
 * is the least surprising answer). Every other emergency break — an
 * unbroken run wider than the box, e.g. one long Latin word — breaks
 * immediately before the code point that would overflow, so those lines
 * never exceed `width`.
 */
function wrapParagraph(text: string, width: number, font: FontMetrics, fontSizePx: number): WrappedParagraphLine[] {
  const codePoints = Array.from(text, (ch) => ch.codePointAt(0) as number);

  if (codePoints.length === 0) {
    // One empty line, so an empty paragraph still occupies a line.
    return [{ text: "", width: 0 }];
  }

  const lines: WrappedParagraphLine[] = [];
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
      // The whole candidate run is measured as one string, every time —
      // never a per-code-point advance summed incrementally — so ligature
      // substitution and pair kerning across the run (and a cmap-uncovered
      // code point, which just measures as .notdef's advance) are always
      // `measureTextWidth`'s call, never this module's own arithmetic
      // (軍令 2).
      const candidate = measureTextWidth(
        font,
        codePointsToString(codePoints, start, cursor + 1),
        fontSizePx,
      );
      if (candidate > width) break;
      accumulated = candidate;
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
      lines.push({ text: codePointsToString(codePoints, start, cursor), width: accumulated });
      break;
    }

    if (cursor === start) {
      // The very first code point of this line is already wider than the
      // box on its own: it takes its own (overflowing) line.
      const soleText = codePointsToString(codePoints, start, start + 1);
      lines.push({ text: soleText, width: measureTextWidth(font, soleText, fontSizePx) });
      start += 1;
      continue;
    }

    if (breakAt > start) {
      lines.push({ text: codePointsToString(codePoints, start, breakAt), width: breakWidth });
      start = breakAt;
    } else {
      // No permitted break anywhere in this run: character-level
      // emergency break right before the code point that overflowed.
      lines.push({ text: codePointsToString(codePoints, start, cursor), width: accumulated });
      start = cursor;
    }
  }

  return lines;
}

/** `x` for one line, from the paragraph's alignment and indent (§7-D of NOOP-65's plan — 已定案). */
function lineX(align: "left" | "center" | "right", width: number, indent: number, lineWidth: number): number {
  if (align === "center") return indent + (width - indent - lineWidth) / 2;
  if (align === "right") return width - lineWidth;
  return indent;
}

/**
 * Splits `text` into paragraphs on `"\n"`, wraps each independently (a
 * paragraph never merges with its neighbour across the break), and
 * concatenates the results with a single, box-wide baseline sequence.
 *
 * Hard breaks are baked in as a boolean flag, never as a character in any
 * line's `text` (NOOP-65 決定 A — 已定案): the line ending a paragraph
 * (every paragraph but the last) carries `hardBreak: true`. This changes
 * the round-trip invariant from `lines.map(l => l.text).join("")` to
 * `lines.map(l => l.text + (l.hardBreak ? "\n" : "")).join("") === text` —
 * see `packages/core/test/text-wrap.test.ts` for the machine-checked proof.
 */
export function wrapText(text: string, options: WrapOptions): WrappedText {
  const { width, font, fontSizePx, align = "left" } = options;
  assertWidth(width);
  if (text.includes("\r")) {
    throw new CoMotionError("文字內容不接受 \\r，硬換行請用 \\n");
  }

  const ascent = (font.ascender / font.unitsPerEm) * fontSizePx;
  // hhea-derived line height (ascender - descender + lineGap), per em. No
  // `line-height` concept exists anywhere else in the slide format yet
  // (W1-R7); a later 行距 feature will have to decide whether it
  // multiplies this number or replaces it.
  const lineHeight =
    ((font.ascender - font.descender + font.lineGap) / font.unitsPerEm) * fontSizePx;

  const paragraphs = text.split("\n");
  const lines: WrappedLine[] = [];

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const indent = options.indents?.[paragraphIndex] ?? 0;
    if (indent >= width) {
      throw new CoMotionError("列表縮排大於文字框寬度，無法排版");
    }
    const paragraphLines = wrapParagraph(paragraph, width - indent, font, fontSizePx);
    const isLastParagraph = paragraphIndex === paragraphs.length - 1;
    paragraphLines.forEach((line, lineIndex) => {
      const isLastLineOfParagraph = lineIndex === paragraphLines.length - 1;
      lines.push({
        text: line.text,
        width: line.width,
        x: lineX(align, width, indent, line.width),
        y: ascent + lines.length * lineHeight,
        hardBreak: isLastLineOfParagraph && !isLastParagraph,
      });
    });
  });

  return { lines, lineHeight, ascent, height: lines.length * lineHeight };
}

function codePointsToString(codePoints: readonly number[], from: number, to: number): string {
  return String.fromCodePoint(...codePoints.slice(from, to));
}
