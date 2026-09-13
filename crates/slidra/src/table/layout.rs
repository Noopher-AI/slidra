// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `computeTableLayout`, ported from `packages/core/src/table/layout.ts`
//! (109 lines, ported in full).
//!
//! Pure layout: from a `TableModel`'s cols/cells to concrete row heights and
//! per-cell geometry. Row heights are ALWAYS core-computed — never accepted
//! from a caller or from the file on disk (that TS file's own header
//! comment states this explicitly) — every write recomputes them here, for
//! both a fresh `table create` and every subsequent edit.

use std::collections::HashMap;

use crate::errors::SlidraResult;
use crate::splice::resolve_font;
use crate::text::font::{DEFAULT_FONT_FAMILY, ParsedFont};
use crate::text::wrap::{Align, WrapOptions, WrappedText, wrap_text};

use super::model::{CellAlign, TableCell, TableModel};

pub const CELL_PADDING_X: f64 = 12.0;
pub const CELL_PADDING_Y: f64 = 8.0;
pub const MIN_ROW_HEIGHT: f64 = 32.0;
pub const DEFAULT_COL_WIDTH: f64 = 160.0;
/// Narrowest a column may be squeezed to by a boundary drag (`table col
/// width --keep-total`): the two paddings plus room for one glyph.
pub const MIN_COL_WIDTH: f64 = 2.0 * CELL_PADDING_X + 16.0;
pub const BODY_FONT_SIZE: f64 = 20.0;
pub const HEADER_FONT_SIZE: f64 = 16.0;
pub const HEADER_FONT_WEIGHT: f64 = 700.0;
pub const BODY_FONT_WEIGHT: f64 = 400.0;

#[derive(Debug)]
pub struct CellLayout {
    /// The source cell this geometry belongs to (`row`/`col` and every
    /// styling field come from here).
    pub cell: TableCell,
    /// Top-left corner, relative to the table container's own origin.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub font_size: f64,
    pub wrapped: WrappedText,
}

#[derive(Debug)]
pub struct TableLayout {
    /// Computed row heights — a hidden template row's height is 0 (it must
    /// not push generated rows down).
    pub rows: Vec<f64>,
    pub cells: Vec<CellLayout>,
}

fn align_to_text_align(align: CellAlign) -> Align {
    match align {
        CellAlign::Left => Align::Left,
        CellAlign::Center => Align::Center,
        CellAlign::Right => Align::Right,
    }
}

fn font_size_for(row: usize, header: bool) -> f64 {
    if row == 0 && header {
        HEADER_FONT_SIZE
    } else {
        BODY_FONT_SIZE
    }
}

fn sum_range(values: &[f64], start: usize, count: usize) -> f64 {
    values[start..start + count].iter().sum()
}

fn cumulative_offsets(values: &[f64]) -> Vec<f64> {
    let mut offsets = Vec::with_capacity(values.len());
    let mut total = 0.0;
    for value in values {
        offsets.push(total);
        total += value;
    }
    offsets
}

/// Computes every row's height and every cell's geometry + wrapped text.
/// `fonts` must carry `DEFAULT_FONT_FAMILY` — a table cell always uses the
/// presentation's default embedded font (no per-cell font-family).
pub fn compute_table_layout(
    model: &TableModel,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<TableLayout> {
    let font = resolve_font(fonts, DEFAULT_FONT_FAMILY, "table")?;

    let mut row_heights = Vec::with_capacity(model.rows.len());
    for row in 0..model.rows.len() {
        let is_template_row = model
            .cells
            .iter()
            .any(|cell| cell.row == row && cell.repeat);
        if is_template_row {
            row_heights.push(0.0);
            continue;
        }

        let mut tallest = MIN_ROW_HEIGHT;
        for cell in model
            .cells
            .iter()
            .filter(|cell| cell.row == row && cell.row_span == 1)
        {
            let width = sum_range(&model.cols, cell.col, cell.col_span) - 2.0 * CELL_PADDING_X;
            let font_size = font_size_for(row, model.header);
            let wrapped = wrap_text(
                &cell.text,
                &WrapOptions {
                    width: width.max(1.0),
                    font,
                    font_size_px: font_size,
                    align: align_to_text_align(cell.align),
                    indents: None,
                },
            )?;
            tallest = tallest.max(wrapped.height + 2.0 * CELL_PADDING_Y);
        }
        row_heights.push(tallest);
    }

    let col_offsets = cumulative_offsets(&model.cols);
    let row_offsets = cumulative_offsets(&row_heights);

    let mut cells = Vec::with_capacity(model.cells.len());
    for cell in &model.cells {
        let width = sum_range(&model.cols, cell.col, cell.col_span);
        let height = sum_range(&row_heights, cell.row, cell.row_span);
        let font_size = font_size_for(cell.row, model.header);
        let usable_width = (width - 2.0 * CELL_PADDING_X).max(1.0);
        let wrapped = wrap_text(
            &cell.text,
            &WrapOptions {
                width: usable_width,
                font,
                font_size_px: font_size,
                align: align_to_text_align(cell.align),
                indents: None,
            },
        )?;
        cells.push(CellLayout {
            cell: cell.clone(),
            x: col_offsets[cell.col],
            y: row_offsets[cell.row],
            width,
            height,
            font_size,
            wrapped,
        });
    }

    Ok(TableLayout {
        rows: row_heights,
        cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::model::{TableCell, TableTheme};
    use crate::text::font::{DEFAULT_FONT_BYTES, parse_font};

    fn fonts_with_default() -> HashMap<String, ParsedFont> {
        let mut book = HashMap::new();
        book.insert(
            DEFAULT_FONT_FAMILY.to_string(),
            parse_font(DEFAULT_FONT_BYTES).unwrap(),
        );
        book
    }

    fn cell(row: usize, col: usize, text: &str) -> TableCell {
        TableCell {
            row,
            col,
            text: text.to_string(),
            align: CellAlign::Left,
            fill: "none".to_string(),
            fill_opacity: None,
            text_fill: "#000000".to_string(),
            font_weight: 400.0,
            row_span: 1,
            col_span: 1,
            repeat: false,
            generated: false,
        }
    }

    #[test]
    fn template_row_height_is_always_zero() {
        let mut model = TableModel {
            cols: vec![100.0],
            rows: vec![0.0],
            header: false,
            theme: TableTheme::Dark,
            source: None,
            cells: vec![cell(0, 0, "template")],
        };
        model.cells[0].repeat = true;
        let layout = compute_table_layout(&model, &fonts_with_default()).unwrap();
        assert_eq!(layout.rows, vec![0.0]);
    }

    #[test]
    fn row_height_is_never_below_min_row_height() {
        let model = TableModel {
            cols: vec![300.0],
            rows: vec![0.0],
            header: false,
            theme: TableTheme::Dark,
            source: None,
            cells: vec![cell(0, 0, "x")],
        };
        let layout = compute_table_layout(&model, &fonts_with_default()).unwrap();
        assert!(layout.rows[0] >= MIN_ROW_HEIGHT);
    }

    #[test]
    fn cell_x_y_come_from_cumulative_offsets() {
        let model = TableModel {
            cols: vec![100.0, 150.0],
            rows: vec![0.0, 0.0],
            header: false,
            theme: TableTheme::Dark,
            source: None,
            cells: vec![
                cell(0, 0, "a"),
                cell(0, 1, "b"),
                cell(1, 0, "c"),
                cell(1, 1, "d"),
            ],
        };
        let layout = compute_table_layout(&model, &fonts_with_default()).unwrap();
        let at = |r: usize, c: usize| {
            layout
                .cells
                .iter()
                .find(|cl| cl.cell.row == r && cl.cell.col == c)
                .unwrap()
        };
        assert_eq!(at(0, 0).x, 0.0);
        assert_eq!(at(0, 1).x, 100.0);
        assert_eq!(at(1, 0).y, layout.rows[0]);
    }

    #[test]
    fn missing_default_font_family_errors() {
        let model = TableModel {
            cols: vec![100.0],
            rows: vec![0.0],
            header: false,
            theme: TableTheme::Dark,
            source: None,
            cells: vec![cell(0, 0, "x")],
        };
        let err = compute_table_layout(&model, &HashMap::new()).unwrap_err();
        // `resolve_font`'s actual message text is "presentation does not embed font ..." (the
        // presentation has no embedded font), not the literal substring
        // "missing font" ("missing font") that the function name suggests.
        assert!(err.message().contains("does not embed font"));
    }
}
