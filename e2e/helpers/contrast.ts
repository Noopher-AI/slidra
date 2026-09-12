/**
 * WCAG 2.x relative-luminance / contrast-ratio maths, shared by the e2e
 * layer (real `getComputedStyle()` colours, always opaque `rgb(...)`) and
 * `apps/web/test/contrast.test.ts` (literal hex/`rgba()` text pulled
 * straight out of tokens.css), which imports this file by relative path
 * since it runs under the root `vitest.config.ts`, not `e2e/vitest.config.ts`.
 *
 * Formula: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance /
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1. Only present when the source text carried an explicit alpha channel. */
  a?: number;
}

const HEX_SHORT = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])?$/;
const HEX_LONG = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/;
const RGB_FN = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/;

/** Parses a `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` hex literal or an `rgb()`/`rgba()` function string. Throws on anything else — this module never guesses at a colour it can't parse exactly. */
export function parseColor(value: string): Rgb {
  const trimmed = value.trim();

  const short = HEX_SHORT.exec(trimmed);
  if (short) {
    const [, r, g, b, a] = short;
    return {
      r: Number.parseInt(r + r, 16),
      g: Number.parseInt(g + g, 16),
      b: Number.parseInt(b + b, 16),
      ...(a ? { a: Number.parseInt(a + a, 16) / 255 } : {}),
    };
  }

  const long = HEX_LONG.exec(trimmed);
  if (long) {
    const [, r, g, b, a] = long;
    return {
      r: Number.parseInt(r, 16),
      g: Number.parseInt(g, 16),
      b: Number.parseInt(b, 16),
      ...(a ? { a: Number.parseInt(a, 16) / 255 } : {}),
    };
  }

  const fn = RGB_FN.exec(trimmed);
  if (fn) {
    const [, r, g, b, a] = fn;
    return {
      r: Number(r),
      g: Number(g),
      b: Number(b),
      ...(a !== undefined ? { a: Number(a) } : {}),
    };
  }

  throw new Error(`parseColor: could not parse color value: ${value}`);
}

/** One channel's contribution to relative luminance (WCAG 2.x). */
function linearize(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque colour, 0 (black) – 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/** WCAG contrast ratio between two opaque colours, 1 (identical) – 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
