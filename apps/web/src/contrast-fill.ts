// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "no accent set" fallback for inserted elements (decision
 * 7, verbatim): a dark page gets a light `fill`/`stroke`, a light page gets
 * a dark one, so the element is never invisible against its own page
 * background. Consumed by `ShapeMenu.tsx` (rect/ellipse `fill`, line
 * `stroke`) and `TextPanel.tsx` (text `fill`) — both already prefer
 * `pageStyle.accent` when one is set; this module only covers the branch
 * where there is none.
 *
 * The two output literals and the "no page background" default are the
 * decision's own values, not swappable design tokens — `design-contract.
 * test.ts`'s INLINE_STYLE_EXCEPTIONS entry for this file says the same.
 */

const LIGHT_BACKGROUND_FILL = "#1f1a1a";
const DARK_BACKGROUND_FILL = "#f4f6f8";
const NO_BACKGROUND_DEFAULT = "#ffffff";

/** WCAG relative luminance's own per-channel curve (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
function linearize(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

const HEX_SHORT = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;
const HEX_LONG = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;
const RGB_FN = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/;

/** Parses the two shapes `page style set --background`/`readPageStyle` actually round-trip today — `#rgb`/`#rrggbb` hex and `rgb()`/`rgba()` — ignoring any alpha channel (a translucent page background still has an opaque colour to contrast against). Returns `null` for anything else, same posture as the rest of this module: no value to guess with, `contrastFill` falls back to the "no background" default. */
function parseRgbChannels(value: string): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();

  const short = HEX_SHORT.exec(trimmed);
  if (short) {
    const [, r, g, b] = short;
    return { r: Number.parseInt(r + r, 16), g: Number.parseInt(g + g, 16), b: Number.parseInt(b + b, 16) };
  }

  const long = HEX_LONG.exec(trimmed);
  if (long) {
    const [, r, g, b] = long;
    return { r: Number.parseInt(r, 16), g: Number.parseInt(g, 16), b: Number.parseInt(b, 16) };
  }

  const fn = RGB_FN.exec(trimmed);
  if (fn) {
    const [, r, g, b] = fn;
    return { r: Number(r), g: Number(g), b: Number(b) };
  }

  return null;
}

/**
 * `background` is `pageStyle.background` — `null` (no page style declared)
 * reads as white, per the decision. An unparseable non-null value (a CSS
 * keyword, a gradient) also falls back to the white default rather than
 * guessing: there's nothing here to compute a luminance from.
 */
export function contrastFill(background: string | null): string {
  const rgb = parseRgbChannels(background ?? NO_BACKGROUND_DEFAULT) ?? parseRgbChannels(NO_BACKGROUND_DEFAULT)!;
  const luminance = relativeLuminance(rgb.r, rgb.g, rgb.b);
  return luminance > 0.5 ? LIGHT_BACKGROUND_FILL : DARK_BACKGROUND_FILL;
}
