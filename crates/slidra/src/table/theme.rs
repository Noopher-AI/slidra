// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `themedCellStyle`, ported from `packages/core/src/table/theme.ts` (73
//! lines, ported in full).
//!
//! Concrete per-theme colours, resolved to `fill`/`fill-opacity` splits at
//! the moment a cell's style is (re)computed by `table create`/`theme
//! set`/`header set` — never written as `rgba()`. A rect's background always
//! alternates `bg`/`zebra` by body-row parity; the difference between the
//! three themes is entirely in these colour values (`dark`'s own `zebra` is
//! `transparent`, i.e. invisible striping).

use super::layout::{BODY_FONT_WEIGHT, HEADER_FONT_WEIGHT};
use super::model::TableTheme;

#[derive(Debug, Clone, Copy)]
struct ResolvedPaint {
    fill: &'static str,
    fill_opacity: Option<f64>,
}

struct ThemeColors {
    bg: ResolvedPaint,
    head: ResolvedPaint,
    zebra: ResolvedPaint,
    color: &'static str,
    head_color: &'static str,
}

fn theme_colors(theme: TableTheme) -> ThemeColors {
    match theme {
        TableTheme::Dark => ThemeColors {
            bg: ResolvedPaint {
                fill: "none",
                fill_opacity: None,
            },
            head: ResolvedPaint {
                fill: "#ffffff",
                fill_opacity: Some(0.06),
            },
            zebra: ResolvedPaint {
                fill: "none",
                fill_opacity: None,
            },
            color: "#e7e9ee",
            head_color: "#a9b0b8",
        },
        TableTheme::Light => ThemeColors {
            bg: ResolvedPaint {
                fill: "#ffffff",
                fill_opacity: None,
            },
            head: ResolvedPaint {
                fill: "#f5f1ef",
                fill_opacity: None,
            },
            zebra: ResolvedPaint {
                fill: "#fbf9f8",
                fill_opacity: None,
            },
            color: "#1f1a1a",
            head_color: "#6e635f",
        },
        TableTheme::Zebra => ThemeColors {
            bg: ResolvedPaint {
                fill: "none",
                fill_opacity: None,
            },
            head: ResolvedPaint {
                fill: "#ffffff",
                fill_opacity: Some(0.08),
            },
            zebra: ResolvedPaint {
                fill: "#ffffff",
                fill_opacity: Some(0.045),
            },
            color: "#e7e9ee",
            head_color: "#a9b0b8",
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThemedCellStyle {
    pub fill: String,
    pub fill_opacity: Option<f64>,
    pub text_fill: String,
    pub font_weight: f64,
}

/// The theme-derived default style for a cell at `row` (`header` says
/// whether row 0 is the header row). Body rows alternate `bg`/`zebra` by
/// their position among body rows (row 0 of the body, not of the whole
/// table) — so toggling the header on/off does not shift which body rows
/// look striped.
pub fn themed_cell_style(theme: TableTheme, header: bool, row: usize) -> ThemedCellStyle {
    let colors = theme_colors(theme);
    if row == 0 && header {
        return ThemedCellStyle {
            fill: colors.head.fill.to_string(),
            fill_opacity: colors.head.fill_opacity,
            text_fill: colors.head_color.to_string(),
            font_weight: HEADER_FONT_WEIGHT,
        };
    }
    let body_row_index = row - usize::from(header);
    let paint = if body_row_index % 2 == 1 {
        colors.zebra
    } else {
        colors.bg
    };
    ThemedCellStyle {
        fill: paint.fill.to_string(),
        fill_opacity: paint.fill_opacity,
        text_fill: colors.color.to_string(),
        font_weight: BODY_FONT_WEIGHT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_row_uses_head_colors_and_weight() {
        let style = themed_cell_style(TableTheme::Dark, true, 0);
        assert_eq!(style.fill, "#ffffff");
        assert_eq!(style.fill_opacity, Some(0.06));
        assert_eq!(style.text_fill, "#a9b0b8");
        assert_eq!(style.font_weight, HEADER_FONT_WEIGHT);
    }

    #[test]
    fn body_rows_alternate_by_position_among_body_rows_not_whole_table() {
        // header=true: row 1 is body row 0 (even -> bg), row 2 is body row 1 (odd -> zebra).
        let row1 = themed_cell_style(TableTheme::Light, true, 1);
        let row2 = themed_cell_style(TableTheme::Light, true, 2);
        assert_eq!(row1.fill, "#ffffff"); // bg
        assert_eq!(row2.fill, "#fbf9f8"); // zebra
    }

    #[test]
    fn toggling_header_does_not_shift_body_striping() {
        // header=false: row 0 is body row 0 (even -> bg), row 1 is body row 1 (odd -> zebra).
        let row0 = themed_cell_style(TableTheme::Light, false, 0);
        let row1 = themed_cell_style(TableTheme::Light, false, 1);
        assert_eq!(row0.fill, "#ffffff"); // bg
        assert_eq!(row1.fill, "#fbf9f8"); // zebra
    }

    #[test]
    fn dark_theme_zebra_is_invisible_striping() {
        let style = themed_cell_style(TableTheme::Dark, false, 1);
        assert_eq!(style.fill, "none");
        assert_eq!(style.fill_opacity, None);
    }

    #[test]
    fn body_font_weight_is_used_for_non_header_rows() {
        let style = themed_cell_style(TableTheme::Zebra, true, 1);
        assert_eq!(style.font_weight, BODY_FONT_WEIGHT);
    }
}
