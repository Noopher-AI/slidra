import { HEADER_FONT_WEIGHT, BODY_FONT_WEIGHT } from "./layout.js";
import type { TableTheme } from "./model.js";

/**
 * Concrete per-theme colours (plan §3.10, from the prototype's
 * `TABLE_THEMES`), resolved to `fill`/`fill-opacity` splits at the moment a
 * cell's style is (re)computed by `table create`/`theme set`/`header set` —
 * never written as `rgba()` (決定 3). A rect's background always
 * alternates `bg`/`zebra` by body-row parity; the difference between the
 * three themes is entirely in these colour values (`dark`'s own `zebra` is
 * `transparent`, i.e. invisible striping).
 */

interface ResolvedPaint {
  fill: string;
  fillOpacity: number | null;
}

interface ThemeColors {
  bg: ResolvedPaint;
  head: ResolvedPaint;
  zebra: ResolvedPaint;
  color: string;
  headColor: string;
}

const THEMES: Record<TableTheme, ThemeColors> = {
  dark: {
    bg: { fill: "none", fillOpacity: null },
    head: { fill: "#ffffff", fillOpacity: 0.06 },
    zebra: { fill: "none", fillOpacity: null },
    color: "#e7e9ee",
    headColor: "#a9b0b8",
  },
  light: {
    bg: { fill: "#ffffff", fillOpacity: null },
    head: { fill: "#f5f1ef", fillOpacity: null },
    zebra: { fill: "#fbf9f8", fillOpacity: null },
    color: "#1f1a1a",
    headColor: "#6e635f",
  },
  zebra: {
    bg: { fill: "none", fillOpacity: null },
    head: { fill: "#ffffff", fillOpacity: 0.08 },
    zebra: { fill: "#ffffff", fillOpacity: 0.045 },
    color: "#e7e9ee",
    headColor: "#a9b0b8",
  },
};

export interface ThemedCellStyle {
  fill: string;
  fillOpacity: number | null;
  textFill: string;
  fontWeight: number;
}

/**
 * The theme-derived default style for a cell at `row` (`header` says
 * whether row 0 is the header row). Body rows alternate `bg`/`zebra` by
 * their position among body rows (row 0 of the body, not of the whole
 * table) — so toggling the header on/off does not shift which body rows
 * look striped.
 */
export function themedCellStyle(theme: TableTheme, header: boolean, row: number): ThemedCellStyle {
  const colors = THEMES[theme];
  if (row === 0 && header) {
    return { fill: colors.head.fill, fillOpacity: colors.head.fillOpacity, textFill: colors.headColor, fontWeight: HEADER_FONT_WEIGHT };
  }
  const bodyRowIndex = row - (header ? 1 : 0);
  const paint = bodyRowIndex % 2 === 1 ? colors.zebra : colors.bg;
  return { fill: paint.fill, fillOpacity: paint.fillOpacity, textFill: colors.color, fontWeight: BODY_FONT_WEIGHT };
}
