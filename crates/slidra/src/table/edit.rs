// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The container-level rewriters for the `table` command family, ported
//! from `packages/core/src/table/edit.ts` (785 lines): every command
//! re-derives the FULL `TableModel` (`read_table_model`), applies one
//! patch, re-validates the whole result, re-renders the WHOLE container
//! (`render_table_markup`) and splices it in place of the old one. Row
//! heights and every baked colour are always recomputed here — a partial
//! splice would leave them stale the moment a cell's text (and therefore
//! its row's height) changes.

use std::collections::{HashMap, HashSet};

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::format::assert_slide_compliant;
use crate::slide::scan::{attribute_value, scan_document};
use crate::text::font::ParsedFont;

use super::csv::ParsedTableCsv;
use super::layout::{DEFAULT_COL_WIDTH, MIN_COL_WIDTH};
use super::markdown::ParsedMarkdownTable;
use super::model::{
    CELL_FONT_WEIGHTS, CellAlign, TableCell, TableModel, TableTheme, read_table_model,
    require_hex_color_6, require_table_container, validate_table_model,
};
use super::render::render_table_markup;
use super::theme::themed_cell_style;

fn read_view_box_exists(svg_content: &str) -> SlidraResult<()> {
    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("root node of the slide is not <svg>"))?;
    let raw = attribute_value(svg_root, "viewBox")
        .ok_or_else(|| SlidraError::invalid("slide is missing viewBox"))?;
    let parts: Vec<f64> = raw
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|token| !token.is_empty())
        .map(|token| crate::argv::parse_js_number(token).unwrap_or(f64::NAN))
        .collect();
    if parts.len() != 4 || parts.iter().any(|value| !value.is_finite()) {
        return Err(SlidraError::invalid(format!(
            "viewBox of the slide is not four numbers: {raw}"
        )));
    }
    Ok(())
}

fn update_table(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    fonts: &HashMap<String, ParsedFont>,
    mutate: impl FnOnce(TableModel) -> SlidraResult<TableModel>,
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    let current = read_table_model(svg_content, element_id)?;
    let next = mutate(current)?;
    validate_table_model(&next)?;

    let roots = scan_document(svg_content)?;
    let container = require_table_container(&roots, element_id)?;
    let transform = attribute_value(container, "transform");
    let markup = render_table_markup(&next, element_id, transform.as_deref(), fonts)?;
    // `start`/`end` are UTF-16 code-unit offsets (see `slide/scan.rs`'s
    // module doc) — must be converted to Rust byte offsets before slicing
    // `svg_content`, or a CJK/astral character earlier in the document
    // corrupts the splice point.
    let start = crate::text::runs::utf16_offset_to_byte_offset(svg_content, container.start);
    let end = crate::text::runs::utf16_offset_to_byte_offset(svg_content, container.end);
    Ok(format!(
        "{}{markup}{}",
        &svg_content[..start],
        &svg_content[end..]
    ))
}

/// Reassigns every cell's theme-derived colour fields by its CURRENT row
/// (discards any per-cell style override — a later theme/header/row change
/// always re-applies the full theme, predictably).
fn restyle_table(cells: Vec<TableCell>, theme: TableTheme, header: bool) -> Vec<TableCell> {
    cells
        .into_iter()
        .map(|cell| {
            let style = themed_cell_style(theme, header, cell.row);
            TableCell {
                fill: style.fill,
                fill_opacity: style.fill_opacity,
                text_fill: style.text_fill,
                font_weight: style.font_weight,
                ..cell
            }
        })
        .collect()
}

fn build_grid_cells(
    row_count: usize,
    col_count: usize,
    theme: TableTheme,
    header: bool,
) -> Vec<TableCell> {
    let mut cells = Vec::with_capacity(row_count * col_count);
    for row in 0..row_count {
        let style = themed_cell_style(theme, header, row);
        for col in 0..col_count {
            cells.push(TableCell {
                row,
                col,
                text: String::new(),
                align: CellAlign::Left,
                fill: style.fill.clone(),
                fill_opacity: style.fill_opacity,
                text_fill: style.text_fill.clone(),
                font_weight: style.font_weight,
                row_span: 1,
                col_span: 1,
                repeat: false,
                generated: false,
            });
        }
    }
    cells
}

// ---------------------------------------------------------------------------
// table create
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CreateTableInput {
    pub rows: f64,
    pub cols: f64,
    pub x: f64,
    pub y: f64,
    pub col_width: Option<f64>,
    pub theme: Option<String>,
    pub header: Option<bool>,
}

pub fn create_table_element(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    input: &CreateTableInput,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    read_view_box_exists(svg_content)?;

    if input.rows.fract() != 0.0 || input.rows < 1.0 {
        return Err(SlidraError::invalid(format!(
            "--rows must be an integer greater than 0: {}",
            super::model::js_number_string(input.rows)
        )));
    }
    if input.cols.fract() != 0.0 || input.cols < 1.0 {
        return Err(SlidraError::invalid(format!(
            "--cols must be an integer greater than 0: {}",
            super::model::js_number_string(input.cols)
        )));
    }
    if !input.x.is_finite() || !input.y.is_finite() {
        return Err(SlidraError::invalid("--x/--y must be finite numbers"));
    }
    let col_width = input.col_width.unwrap_or(DEFAULT_COL_WIDTH);
    if !col_width.is_finite() || col_width <= 0.0 {
        return Err(SlidraError::invalid(format!(
            "--col-width must be a finite number greater than 0: {}",
            super::model::js_number_string(col_width)
        )));
    }
    let theme = match &input.theme {
        None => TableTheme::Dark,
        Some(raw) => TableTheme::parse(raw).ok_or_else(|| {
            SlidraError::invalid(format!(
                "unsupported theme, valid values are: {} (received: {raw})",
                TableTheme::DOMAIN.join(", ")
            ))
        })?,
    };
    let header = input.header.unwrap_or(true);

    let rows = input.rows as usize;
    let cols = input.cols as usize;
    let cell_grid = build_grid_cells(rows, cols, theme, header);
    let model = TableModel {
        cols: vec![col_width; cols],
        rows: vec![0.0; rows],
        header,
        theme,
        source: None,
        cells: cell_grid,
    };
    validate_table_model(&model)?;

    let transform = format!(
        "translate({} {})",
        crate::svgnum::format_js_number(input.x),
        crate::svgnum::format_js_number(input.y)
    );
    let markup = render_table_markup(&model, element_id, Some(&transform), fonts)?;

    let roots = scan_document(svg_content)?;
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .expect("assert_slide_compliant already confirmed the root is <svg>");
    // See `update_table`'s identical conversion above for why this cannot
    // be a direct byte-index slice.
    let content_end =
        crate::text::runs::utf16_offset_to_byte_offset(svg_content, svg_root.content_end);
    Ok(format!(
        "{}{markup}{}",
        &svg_content[..content_end],
        &svg_content[content_end..]
    ))
}

// ---------------------------------------------------------------------------
// table cell set
// ---------------------------------------------------------------------------

/// `row`/`col` are `f64`, not `usize`: TS's `setTableCellText` never checks
/// `Number.isInteger` on these — it looks a cell up by plain `===`
/// equality (`model.cells.findIndex((cell) => cell.row === row && cell.col
/// === col)`), so a fractional or negative value simply matches no real
/// cell (which always has an integer, non-negative `row`/`col`) and falls
/// through to "cell not found", exactly like an out-of-range integer would.
/// Converting to `usize` before this lookup (via `as usize`, which
/// saturates/truncates rather than erroring) would make `--row -1` alias
/// row 0 and `--row 1.5` alias row 1 — silently matching a real cell TS
/// would report as not found.
pub fn set_table_cell_text(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    row: f64,
    col: f64,
    text: &str,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    let text = text.to_string();
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        let mut cells = model.cells;
        let index = cells
            .iter()
            .position(|cell| cell.row as f64 == row && cell.col as f64 == col)
            .ok_or_else(|| {
                SlidraError::invalid(format!(
                    "cell not found: ({},{})",
                    super::model::js_number_string(row),
                    super::model::js_number_string(col)
                ))
            })?;
        cells[index] = TableCell {
            text,
            ..cells[index].clone()
        };
        Ok(TableModel { cells, ..model })
    })
}

/// `table cell cut/paste`: sets several cells' text in ONE re-render, so
/// the caller's single `write_presentation_file` is one undo step.
pub fn set_table_cell_texts(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    entries: &[(usize, usize, String)],
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    let entries = entries.to_vec();
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        let mut cells = model.cells;
        for (row, col, text) in &entries {
            let index = cells
                .iter()
                .position(|cell| cell.row == *row && cell.col == *col)
                .ok_or_else(|| SlidraError::invalid(format!("cell not found: ({row},{col})")))?;
            cells[index] = TableCell {
                text: text.clone(),
                ..cells[index].clone()
            };
        }
        Ok(TableModel { cells, ..model })
    })
}

// ---------------------------------------------------------------------------
// table cell style set
// ---------------------------------------------------------------------------

/// `row`/`col`/`row_end`/`col_end` are `f64`, matching TS's un-integer-
/// checked `number` fields — the range comparison below (`cell.row >=
/// row_start && cell.row <= row_end`) naturally matches no cell at all for
/// a fractional/out-of-range bound, exactly like TS's `>=`/`<=` on a
/// `number` does, rather than an `as usize` truncation quietly aliasing a
/// different row.
#[derive(Debug, Clone)]
pub struct SetCellStyleInput {
    pub row: f64,
    pub col: f64,
    pub row_end: Option<f64>,
    pub col_end: Option<f64>,
    pub attr: String,
    pub value: String,
}

fn patch_cell_style(cell: TableCell, attr: &str, value: &str) -> SlidraResult<TableCell> {
    match attr {
        "align" => {
            let align = CellAlign::parse(value).ok_or_else(|| {
                SlidraError::invalid(format!(
                    "align must be one of the following: {} (received: {value})",
                    CellAlign::DOMAIN.join(", ")
                ))
            })?;
            Ok(TableCell { align, ..cell })
        }
        "font-weight" => {
            let weight = crate::argv::parse_js_number(value).unwrap_or(f64::NAN);
            if !CELL_FONT_WEIGHTS.contains(&weight) {
                return Err(SlidraError::invalid(format!(
                    "font-weight must be a multiple of 100 between 100 and 900: {value}"
                )));
            }
            Ok(TableCell {
                font_weight: weight,
                ..cell
            })
        }
        "fill" => {
            if value != "none" && is_hex_6_strict(value).is_err() {
                return Err(SlidraError::invalid(format!(
                    "fill must be none or #RRGGBB: {value}"
                )));
            }
            Ok(TableCell {
                fill: value.to_string(),
                fill_opacity: None,
                ..cell
            })
        }
        "text-fill" => {
            require_hex_color_6(value, "text-fill")?;
            Ok(TableCell {
                text_fill: value.to_string(),
                ..cell
            })
        }
        other => Err(SlidraError::invalid(format!(
            "unsupported style attribute: {other}"
        ))),
    }
}

/// `HEX_OR_NONE = /^#([0-9a-fA-F]{6})$/` from `table/edit.ts` — a second,
/// independent hex-format check from `model.rs`'s `require_hex_color_6`
/// (TS itself has two separate checks in two separate files; not
/// consolidated here either, to stay a faithful port).
fn is_hex_6_strict(value: &str) -> SlidraResult<()> {
    let bytes = value.as_bytes();
    if bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit) {
        Ok(())
    } else {
        Err(SlidraError::invalid(""))
    }
}

pub fn set_table_cell_style(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    input: SetCellStyleInput,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        let row_start = input.row.min(input.row_end.unwrap_or(input.row));
        let row_end = input.row.max(input.row_end.unwrap_or(input.row));
        let col_start = input.col.min(input.col_end.unwrap_or(input.col));
        let col_end = input.col.max(input.col_end.unwrap_or(input.col));

        let mut matched = false;
        let mut cells = Vec::with_capacity(model.cells.len());
        for cell in model.cells {
            if cell.row as f64 >= row_start
                && cell.row as f64 <= row_end
                && cell.col as f64 >= col_start
                && cell.col as f64 <= col_end
            {
                matched = true;
                cells.push(patch_cell_style(cell, &input.attr, &input.value)?);
            } else {
                cells.push(cell);
            }
        }
        if !matched {
            return Err(SlidraError::invalid("no cells in the specified range"));
        }
        Ok(TableModel { cells, ..model })
    })
}

// ---------------------------------------------------------------------------
// table merge / unmerge
// ---------------------------------------------------------------------------

fn rect_overlaps(
    cell: &TableCell,
    row: usize,
    col: usize,
    row_span: usize,
    col_span: usize,
) -> bool {
    cell.row < row + row_span
        && cell.row + cell.row_span > row
        && cell.col < col + col_span
        && cell.col + cell.col_span > col
}

fn split_cell(cell: &TableCell) -> Vec<TableCell> {
    let mut parts = Vec::new();
    for r in cell.row..cell.row + cell.row_span {
        for c in cell.col..cell.col + cell.col_span {
            parts.push(TableCell {
                row: r,
                col: c,
                row_span: 1,
                col_span: 1,
                text: if r == cell.row && c == cell.col {
                    cell.text.clone()
                } else {
                    String::new()
                },
                ..cell.clone()
            });
        }
    }
    parts
}

/// `row`/`col` are `f64`, matching TS's un-integer-checked `number` fields
/// used only for the initial `===`-equality cell lookup (see
/// `set_table_cell_text`'s doc comment for why this must not be an `as
/// usize` conversion). Once that lookup succeeds, `target.row`/`target.col`
/// (guaranteed float-equal to `row`/`col` by construction) stand in for
/// every subsequent use — TS's own `input.row`/`input.col` are likewise
/// only ever used post-lookup where they are already known to equal a
/// real, integer `cell.row`/`cell.col`.
#[derive(Debug, Clone, Default)]
pub struct MergeTableCellsInput {
    pub row: f64,
    pub col: f64,
    pub row_span: Option<f64>,
    pub col_span: Option<f64>,
    pub unmerge: bool,
}

pub fn merge_table_cells(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    input: MergeTableCellsInput,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        let target = model
            .cells
            .iter()
            .find(|cell| cell.row as f64 == input.row && cell.col as f64 == input.col)
            .cloned()
            .ok_or_else(|| {
                SlidraError::invalid(format!(
                    "cell not found: ({},{})",
                    super::model::js_number_string(input.row),
                    super::model::js_number_string(input.col)
                ))
            })?;
        let (row, col) = (target.row, target.col);

        if input.unmerge {
            if target.row_span == 1 && target.col_span == 1 {
                return Err(SlidraError::invalid(format!(
                    "cell ({row},{col}) is not merged, cannot unmerge"
                )));
            }
            // Borrow (never `into_iter`) so `model`'s other fields stay
            // intact for the `..model` struct-update below — `model.cells`
            // is the only field this function ever changes.
            let mut cells: Vec<TableCell> = model
                .cells
                .iter()
                .filter(|cell| !(cell.row == row && cell.col == col))
                .cloned()
                .collect();
            cells.extend(split_cell(&target));
            return Ok(TableModel { cells, ..model });
        }

        let row_span_raw = input.row_span.unwrap_or(1.0);
        let col_span_raw = input.col_span.unwrap_or(1.0);
        if row_span_raw.fract() != 0.0
            || col_span_raw.fract() != 0.0
            || row_span_raw < 1.0
            || col_span_raw < 1.0
        {
            return Err(SlidraError::invalid(
                "merge range must be a positive integer",
            ));
        }
        let row_span = row_span_raw as usize;
        let col_span = col_span_raw as usize;
        if row + row_span > model.rows.len() || col + col_span > model.cols.len() {
            return Err(SlidraError::invalid("merge range out of table"));
        }

        if row_span == 1 && col_span == 1 {
            if target.row_span == 1 && target.col_span == 1 {
                return Ok(model); // already unmerged: no-op
            }
            let mut cells: Vec<TableCell> = model
                .cells
                .iter()
                .filter(|cell| !(cell.row == row && cell.col == col))
                .cloned()
                .collect();
            cells.extend(split_cell(&target));
            return Ok(TableModel { cells, ..model });
        }

        let covered: Vec<TableCell> = model
            .cells
            .iter()
            .filter(|cell| rect_overlaps(cell, row, col, row_span, col_span))
            .cloned()
            .collect();
        for cell in &covered {
            let within_row = cell.row >= row && cell.row + cell.row_span <= row + row_span;
            let within_col = cell.col >= col && cell.col + cell.col_span <= col + col_span;
            if !within_row || !within_col {
                return Err(SlidraError::invalid(
                    "merge range overlaps with an existing merge",
                ));
            }
        }

        let mut remaining: Vec<TableCell> = model
            .cells
            .iter()
            .filter(|cell| {
                !covered
                    .iter()
                    .any(|c| c.row == cell.row && c.col == cell.col)
            })
            .cloned()
            .collect();
        remaining.push(TableCell {
            row,
            col,
            row_span,
            col_span,
            ..target
        });
        Ok(TableModel {
            cells: remaining,
            ..model
        })
    })
}

// ---------------------------------------------------------------------------
// table col width / insert / delete
// ---------------------------------------------------------------------------

/// `--keep-total`: the column to the right absorbs the difference so the
/// table's total width is unchanged — what dragging a column boundary in
/// the GUI means.
pub fn set_table_col_width(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    col: f64,
    width: f64,
    fonts: &HashMap<String, ParsedFont>,
    keep_total: bool,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        if col.fract() != 0.0 || col < 0.0 || col >= model.cols.len() as f64 {
            return Err(SlidraError::invalid(format!(
                "--col out of range: {}",
                super::model::js_number_string(col)
            )));
        }
        let col = col as usize;
        if !width.is_finite() || width <= 0.0 {
            return Err(SlidraError::invalid(format!(
                "--width must be a finite number greater than 0: {}",
                super::model::js_number_string(width)
            )));
        }
        let mut cols = model.cols.clone();
        if keep_total {
            if col == cols.len() - 1 {
                return Err(SlidraError::invalid(
                    "--keep-total requires a column to the right to absorb the difference: last column not applicable",
                ));
            }
            let next = cols[col + 1] - (width - cols[col]);
            if next < MIN_COL_WIDTH {
                return Err(SlidraError::invalid(format!(
                    "the right column would be smaller than the minimum column width {MIN_COL_WIDTH}: {}",
                    super::model::js_number_string(next)
                )));
            }
            cols[col + 1] = next;
        }
        cols[col] = width;
        Ok(TableModel { cols, ..model })
    })
}

pub fn insert_table_column(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    at: f64,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        if at.fract() != 0.0 || at < 0.0 || at > model.cols.len() as f64 {
            return Err(SlidraError::invalid(format!(
                "--at out of range: {}",
                super::model::js_number_string(at)
            )));
        }
        let at = at as usize;
        let mut cols = model.cols.clone();
        cols.insert(at, DEFAULT_COL_WIDTH);

        let mut spanned_rows: HashSet<usize> = HashSet::new();
        let mut cells: Vec<TableCell> = model
            .cells
            .iter()
            .cloned()
            .map(|cell| {
                if cell.col + cell.col_span <= at {
                    cell
                } else if cell.col >= at {
                    TableCell {
                        col: cell.col + 1,
                        ..cell
                    }
                } else {
                    for r in cell.row..cell.row + cell.row_span {
                        spanned_rows.insert(r);
                    }
                    TableCell {
                        col_span: cell.col_span + 1,
                        ..cell
                    }
                }
            })
            .collect();

        for row in 0..model.rows.len() {
            if spanned_rows.contains(&row) {
                continue;
            }
            let style = themed_cell_style(model.theme, model.header, row);
            let repeat = model
                .cells
                .iter()
                .any(|cell| cell.row == row && cell.repeat);
            let generated = model
                .cells
                .iter()
                .any(|cell| cell.row == row && cell.generated);
            cells.push(TableCell {
                row,
                col: at,
                text: String::new(),
                align: CellAlign::Left,
                fill: style.fill,
                fill_opacity: style.fill_opacity,
                text_fill: style.text_fill,
                font_weight: style.font_weight,
                row_span: 1,
                col_span: 1,
                repeat,
                generated,
            });
        }

        Ok(TableModel {
            cols,
            cells,
            ..model
        })
    })
}

pub fn delete_table_column(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    at: f64,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        if at.fract() != 0.0 || at < 0.0 || at >= model.cols.len() as f64 {
            return Err(SlidraError::invalid(format!(
                "--at out of range: {}",
                super::model::js_number_string(at)
            )));
        }
        let at = at as usize;
        if model.cols.len() == 1 {
            return Err(SlidraError::invalid("table must have at least one column"));
        }
        let mut cols = model.cols.clone();
        cols.remove(at);

        let mut cells = Vec::with_capacity(model.cells.len());
        for cell in &model.cells {
            if cell.col <= at && cell.col + cell.col_span > at {
                let new_span = cell.col_span.saturating_sub(1);
                if new_span == 0 {
                    continue;
                }
                cells.push(TableCell {
                    col_span: new_span,
                    ..cell.clone()
                });
            } else if cell.col > at {
                cells.push(TableCell {
                    col: cell.col - 1,
                    ..cell.clone()
                });
            } else {
                cells.push(cell.clone());
            }
        }
        Ok(TableModel {
            cols,
            cells,
            ..model
        })
    })
}

// ---------------------------------------------------------------------------
// table row insert / delete
// ---------------------------------------------------------------------------

pub fn insert_table_row(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    at: f64,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        if at.fract() != 0.0 || at < 0.0 || at > model.rows.len() as f64 {
            return Err(SlidraError::invalid(format!(
                "--at out of range: {}",
                super::model::js_number_string(at)
            )));
        }
        let at = at as usize;
        let mut spanned_cols: HashSet<usize> = HashSet::new();
        let mut cells: Vec<TableCell> = model
            .cells
            .iter()
            .cloned()
            .map(|cell| {
                if cell.row + cell.row_span <= at {
                    cell
                } else if cell.row >= at {
                    TableCell {
                        row: cell.row + 1,
                        ..cell
                    }
                } else {
                    for c in cell.col..cell.col + cell.col_span {
                        spanned_cols.insert(c);
                    }
                    TableCell {
                        row_span: cell.row_span + 1,
                        ..cell
                    }
                }
            })
            .collect();

        for col in 0..model.cols.len() {
            if spanned_cols.contains(&col) {
                continue;
            }
            cells.push(TableCell {
                row: at,
                col,
                text: String::new(),
                align: CellAlign::Left,
                fill: "none".to_string(),
                fill_opacity: None,
                text_fill: "#000000".to_string(),
                font_weight: 400.0,
                row_span: 1,
                col_span: 1,
                repeat: false,
                generated: false,
            });
        }

        let row_count = model.rows.len() + 1;
        let theme = model.theme;
        let header = model.header;
        cells = restyle_table(cells, theme, header);
        Ok(TableModel {
            rows: vec![0.0; row_count],
            cells,
            ..model
        })
    })
}

pub fn delete_table_row(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    at: f64,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        if at.fract() != 0.0 || at < 0.0 || at >= model.rows.len() as f64 {
            return Err(SlidraError::invalid(format!(
                "--at out of range: {}",
                super::model::js_number_string(at)
            )));
        }
        let at = at as usize;
        if model.rows.len() == 1 {
            return Err(SlidraError::invalid("table must have at least one row"));
        }
        let is_template_row = model.cells.iter().any(|cell| cell.row == at && cell.repeat);
        if is_template_row {
            return Err(SlidraError::invalid(
                "template row cannot be deleted, unbind first",
            ));
        }

        let mut cells = Vec::with_capacity(model.cells.len());
        for cell in &model.cells {
            if cell.row <= at && cell.row + cell.row_span > at {
                let new_span = cell.row_span.saturating_sub(1);
                if new_span == 0 {
                    continue;
                }
                cells.push(TableCell {
                    row_span: new_span,
                    ..cell.clone()
                });
            } else if cell.row > at {
                cells.push(TableCell {
                    row: cell.row - 1,
                    ..cell.clone()
                });
            } else {
                cells.push(cell.clone());
            }
        }
        let row_count = model.rows.len() - 1;
        let theme = model.theme;
        let header = model.header;
        cells = restyle_table(cells, theme, header);
        Ok(TableModel {
            rows: vec![0.0; row_count],
            cells,
            ..model
        })
    })
}

// ---------------------------------------------------------------------------
// table theme set / header set
// ---------------------------------------------------------------------------

pub fn set_table_theme(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    theme: &str,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    let theme = TableTheme::parse(theme).ok_or_else(|| {
        SlidraError::invalid(format!(
            "unsupported theme, valid values are: {} (received: {theme})",
            TableTheme::DOMAIN.join(", ")
        ))
    })?;
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        let header = model.header;
        let cells = restyle_table(model.cells, theme, header);
        Ok(TableModel {
            theme,
            cells,
            ..model
        })
    })
}

pub fn set_table_header(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    header: bool,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        let theme = model.theme;
        let cells = restyle_table(model.cells, theme, header);
        Ok(TableModel {
            header,
            cells,
            ..model
        })
    })
}

// ---------------------------------------------------------------------------
// table bind / refresh — CSV expansion
// ---------------------------------------------------------------------------

/// `\{\{\s*([^{}]+?)\s*\}\}` hand-written (no `regex` crate in this
/// crate's dependency budget) — scans for the next `{{`/`}}` pair, trims
/// the inner name, and substitutes it. A name containing `{` or `}` never
/// matches (mirrors the TS regex's `[^{}]+?` class).
fn substitute_template(text: &str, headers: &[String], values: &[String]) -> SlidraResult<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some(open) = rest.find("{{") else {
            out.push_str(rest);
            break;
        };
        let (before, after_open) = rest.split_at(open);
        let after_open = &after_open[2..];
        let Some(close) = after_open.find("}}") else {
            out.push_str(rest);
            break;
        };
        let raw_name = &after_open[..close];
        out.push_str(before);
        let name = raw_name.trim();
        if name.is_empty() {
            return Err(SlidraError::invalid(
                "{{ }} in a template cell cannot be an empty name",
            ));
        }
        let index = headers.iter().position(|h| h == name).ok_or_else(|| {
            SlidraError::invalid(format!(
                "column name not found: {{{{ {name} }}}}, available column names: {}",
                headers.join(", ")
            ))
        })?;
        out.push_str(&values[index]);
        rest = &after_open[close + 2..];
    }
    Ok(out)
}

/// Removes every `generated` cell and re-numbers the remaining rows
/// contiguously — the "delete all generated cells" half of a refresh.
fn strip_generated_rows(cells: &[TableCell]) -> Vec<TableCell> {
    let remaining: Vec<&TableCell> = cells.iter().filter(|cell| !cell.generated).collect();
    let mut unique_rows: Vec<usize> = remaining.iter().map(|cell| cell.row).collect();
    unique_rows.sort_unstable();
    unique_rows.dedup();
    let remap: HashMap<usize, usize> = unique_rows
        .into_iter()
        .enumerate()
        .map(|(index, row)| (row, index))
        .collect();
    remaining
        .into_iter()
        .map(|cell| TableCell {
            row: remap[&cell.row],
            ..cell.clone()
        })
        .collect()
}

fn expand_template_row(
    cells: &[TableCell],
    template_row: usize,
    csv: &ParsedTableCsv,
) -> SlidraResult<(Vec<TableCell>, usize)> {
    let template_cells: Vec<&TableCell> = cells
        .iter()
        .filter(|cell| cell.row == template_row)
        .collect();
    let shifted: Vec<TableCell> = cells
        .iter()
        .cloned()
        .map(|cell| {
            if cell.row > template_row {
                TableCell {
                    row: cell.row + csv.rows.len(),
                    ..cell
                }
            } else {
                cell
            }
        })
        .collect();

    let mut generated = Vec::new();
    for (row_offset, values) in csv.rows.iter().enumerate() {
        let new_row = template_row + 1 + row_offset;
        for template_cell in &template_cells {
            generated.push(TableCell {
                row: new_row,
                text: substitute_template(&template_cell.text, &csv.headers, values)?,
                repeat: false,
                generated: true,
                ..(*template_cell).clone()
            });
        }
    }

    // `new Set(shifted.map(r)).size + csv.rows.length` (TS) — the shifted
    // set's distinct row count, plus one row per CSV data row.
    let distinct_rows: HashSet<usize> = shifted.iter().map(|cell| cell.row).collect();
    let row_count = distinct_rows.len() + csv.rows.len();

    let mut cells = shifted;
    cells.extend(generated);
    Ok((cells, row_count))
}

pub fn bind_table_source(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    source: &str,
    template_row: Option<f64>,
    csv: &ParsedTableCsv,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    let source = source.to_string();
    let csv = csv.clone();
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        let stripped: Vec<TableCell> = strip_generated_rows(&model.cells)
            .into_iter()
            .map(|cell| TableCell {
                repeat: false,
                ..cell
            })
            .collect();
        let row_count_after_strip: usize = stripped
            .iter()
            .map(|cell| cell.row)
            .collect::<HashSet<_>>()
            .len();

        let resolved_template_row = match template_row {
            Some(requested) => {
                if requested.fract() != 0.0
                    || requested < 0.0
                    || requested >= row_count_after_strip as f64
                {
                    return Err(SlidraError::invalid(format!(
                        "--template-row out of range: {}",
                        super::model::js_number_string(requested)
                    )));
                }
                let requested = requested as usize;
                if model.header && requested == 0 {
                    return Err(SlidraError::invalid(
                        "header row cannot serve as a template row",
                    ));
                }
                requested
            }
            None => {
                if model.header && row_count_after_strip == 1 {
                    return Err(SlidraError::invalid(
                        "table only has a header row, no row can serve as a template",
                    ));
                }
                let mut placeholder_rows: Vec<usize> = stripped
                    .iter()
                    .filter(|cell| cell.text.contains("{{") && !(model.header && cell.row == 0))
                    .map(|cell| cell.row)
                    .collect();
                placeholder_rows.sort_unstable();
                placeholder_rows
                    .first()
                    .copied()
                    .unwrap_or(row_count_after_strip - 1)
            }
        };

        let with_template_mark: Vec<TableCell> = stripped
            .into_iter()
            .map(|cell| {
                if cell.row == resolved_template_row {
                    TableCell {
                        repeat: true,
                        ..cell
                    }
                } else {
                    cell
                }
            })
            .collect();
        let (cells, row_count) =
            expand_template_row(&with_template_mark, resolved_template_row, &csv)?;
        Ok(TableModel {
            source: Some(source),
            rows: vec![0.0; row_count],
            cells,
            ..model
        })
    })
}

pub fn refresh_table_source(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    csv: &ParsedTableCsv,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    let csv = csv.clone();
    let element_id_for_error = element_id.to_string();
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        if model.source.is_none() {
            return Err(SlidraError::invalid(format!(
                "table {element_id_for_error} has no data source"
            )));
        }
        let stripped = strip_generated_rows(&model.cells);
        let template_row = stripped
            .iter()
            .find(|cell| cell.repeat)
            .map(|cell| cell.row)
            .ok_or_else(|| {
                SlidraError::invalid(format!("table {element_id_for_error} has no template row"))
            })?;
        let (cells, row_count) = expand_template_row(&stripped, template_row, &csv)?;
        Ok(TableModel {
            rows: vec![0.0; row_count],
            cells,
            ..model
        })
    })
}

// ---------------------------------------------------------------------------
// table set --from / --markdown
// ---------------------------------------------------------------------------

struct GridData {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    aligns: Option<Vec<CellAlign>>,
}

fn build_table_from_grid(existing_cols: &[f64], theme: TableTheme, data: GridData) -> TableModel {
    let col_count = data.headers.len();
    let cols: Vec<f64> = (0..col_count)
        .map(|index| {
            existing_cols
                .get(index)
                .copied()
                .unwrap_or(DEFAULT_COL_WIDTH)
        })
        .collect();

    let mut all_rows: Vec<Vec<String>> = Vec::with_capacity(1 + data.rows.len());
    all_rows.push(data.headers);
    all_rows.extend(data.rows);

    let mut cells = Vec::new();
    for (row, row_values) in all_rows.iter().enumerate() {
        let style = themed_cell_style(theme, true, row);
        for (col, text) in row_values.iter().enumerate() {
            let align = data
                .aligns
                .as_ref()
                .and_then(|aligns| aligns.get(col))
                .copied()
                .unwrap_or(CellAlign::Left);
            cells.push(TableCell {
                row,
                col,
                text: text.clone(),
                align,
                fill: style.fill.clone(),
                fill_opacity: style.fill_opacity,
                text_fill: style.text_fill.clone(),
                font_weight: style.font_weight,
                row_span: 1,
                col_span: 1,
                repeat: false,
                generated: false,
            });
        }
    }

    TableModel {
        cols,
        rows: vec![0.0; all_rows.len()],
        header: true,
        theme,
        source: None,
        cells,
    }
}

pub fn set_table_from_csv(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    csv: &ParsedTableCsv,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    let csv = csv.clone();
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        Ok(build_table_from_grid(
            &model.cols,
            model.theme,
            GridData {
                headers: csv.headers,
                rows: csv.rows,
                aligns: None,
            },
        ))
    })
}

pub fn set_table_from_markdown(
    svg_content: &str,
    slide_path: &str,
    element_id: &str,
    markdown: &ParsedMarkdownTable,
    fonts: &HashMap<String, ParsedFont>,
) -> SlidraResult<String> {
    let markdown = markdown.clone();
    update_table(svg_content, slide_path, element_id, fonts, move |model| {
        Ok(build_table_from_grid(
            &model.cols,
            model.theme,
            GridData {
                headers: markdown.headers,
                rows: markdown.rows,
                aligns: Some(markdown.aligns),
            },
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::font::{DEFAULT_FONT_BYTES, DEFAULT_FONT_FAMILY, parse_font};

    fn fonts_with_default() -> HashMap<String, ParsedFont> {
        let mut book = HashMap::new();
        book.insert(
            DEFAULT_FONT_FAMILY.to_string(),
            parse_font(DEFAULT_FONT_BYTES).unwrap(),
        );
        book
    }

    fn slide_with_viewbox() -> String {
        r#"<svg viewBox="0 0 1280 720"></svg>"#.to_string()
    }

    fn create_2x2(svg: &str) -> String {
        create_table_element(
            svg,
            "slides/001.svg",
            "t1",
            &CreateTableInput {
                rows: 2.0,
                cols: 2.0,
                x: 10.0,
                y: 20.0,
                col_width: None,
                theme: None,
                header: Some(false),
            },
            &fonts_with_default(),
        )
        .unwrap()
    }

    #[test]
    fn create_table_element_builds_grid_and_transform() {
        let svg = create_2x2(&slide_with_viewbox());
        assert!(svg.contains(r#"id="t1" data-slidra-type="table""#));
        assert!(svg.contains("transform=\"translate(10 20)\""));
        assert!(svg.contains(r#"data-slidra-cell="0,0""#));
        assert!(svg.contains(r#"data-slidra-cell="1,1""#));
    }

    #[test]
    fn create_table_element_rejects_non_integer_rows() {
        let err = create_table_element(
            &slide_with_viewbox(),
            "slides/001.svg",
            "t1",
            &CreateTableInput {
                rows: 1.5,
                cols: 2.0,
                x: 0.0,
                y: 0.0,
                ..Default::default()
            },
            &fonts_with_default(),
        )
        .unwrap_err();
        assert!(
            err.message()
                .contains("--rows must be an integer greater than 0")
        );
    }

    #[test]
    fn set_table_cell_text_round_trips() {
        let svg = create_2x2(&slide_with_viewbox());
        let updated = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            0.0,
            1.0,
            "hello",
            &fonts_with_default(),
        )
        .unwrap();
        let model = read_table_model(&updated, "t1").unwrap();
        let cell = model
            .cells
            .iter()
            .find(|c| c.row == 0 && c.col == 1)
            .unwrap();
        assert_eq!(cell.text, "hello");
    }

    #[test]
    fn set_table_cell_text_missing_cell_errors() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            5.0,
            5.0,
            "x",
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "cell not found: (5,5)");
    }

    /// Regression for the `f64`/`usize` fix `set_table_cell_text`'s own doc
    /// comment describes: `--row -1` must NOT truncate/saturate to row 0
    /// (an `as usize` cast would do exactly that) — a negative row matches
    /// no real cell (rows are always non-negative), so this must report
    /// "cell not found", never silently edit row 0.
    #[test]
    fn set_table_cell_text_negative_row_does_not_alias_row_zero() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            -1.0,
            0.0,
            "x",
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "cell not found: (-1,0)");
    }

    /// Same regression, the fractional half: `--row 1.5` must NOT truncate
    /// to row 1 (an `as usize` cast would do exactly that) — a fractional
    /// row matches no real cell (rows are always integers), so this must
    /// report "cell not found", never silently edit row 1.
    #[test]
    fn set_table_cell_text_fractional_row_does_not_alias_row_one() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            1.5,
            0.0,
            "x",
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "cell not found: (1.5,0)");
    }

    #[test]
    fn merge_then_unmerge_round_trips_cell_count() {
        let svg = create_2x2(&slide_with_viewbox());
        let merged = merge_table_cells(
            &svg,
            "slides/001.svg",
            "t1",
            MergeTableCellsInput {
                row: 0.0,
                col: 0.0,
                row_span: Some(2.0),
                col_span: Some(1.0),
                unmerge: false,
            },
            &fonts_with_default(),
        )
        .unwrap();
        let merged_model = read_table_model(&merged, "t1").unwrap();
        assert_eq!(merged_model.cells.len(), 3); // 4 - 1 (merged away)
        let merged_cell = merged_model
            .cells
            .iter()
            .find(|c| c.row == 0 && c.col == 0)
            .unwrap();
        assert_eq!(merged_cell.row_span, 2);

        let unmerged = merge_table_cells(
            &merged,
            "slides/001.svg",
            "t1",
            MergeTableCellsInput {
                row: 0.0,
                col: 0.0,
                unmerge: true,
                ..Default::default()
            },
            &fonts_with_default(),
        )
        .unwrap();
        let unmerged_model = read_table_model(&unmerged, "t1").unwrap();
        assert_eq!(unmerged_model.cells.len(), 4);
    }

    #[test]
    fn merge_overlapping_existing_span_errors() {
        let svg = create_2x2(&slide_with_viewbox());
        // First merge (0,0)-(1,0) vertically.
        let merged = merge_table_cells(
            &svg,
            "slides/001.svg",
            "t1",
            MergeTableCellsInput {
                row: 0.0,
                col: 0.0,
                row_span: Some(2.0),
                col_span: Some(1.0),
                unmerge: false,
            },
            &fonts_with_default(),
        )
        .unwrap();
        // A merge covering (0,0)-(0,1) partially overlaps the existing
        // vertical span without fully containing it -> error.
        let err = merge_table_cells(
            &merged,
            "slides/001.svg",
            "t1",
            MergeTableCellsInput {
                row: 0.0,
                col: 0.0,
                row_span: Some(1.0),
                col_span: Some(2.0),
                unmerge: false,
            },
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "merge range overlaps with an existing merge");
    }

    #[test]
    fn insert_column_shifts_columns_at_and_after() {
        let svg = create_2x2(&slide_with_viewbox());
        let updated =
            insert_table_column(&svg, "slides/001.svg", "t1", 1.0, &fonts_with_default()).unwrap();
        let model = read_table_model(&updated, "t1").unwrap();
        assert_eq!(model.cols.len(), 3);
        // Original col 1 cells shifted to col 2; a new col at index 1 was inserted.
        assert!(model.cells.iter().any(|c| c.row == 0 && c.col == 1));
        assert!(model.cells.iter().any(|c| c.row == 0 && c.col == 2));
    }

    #[test]
    fn delete_column_rejects_the_last_remaining_column() {
        let svg = create_table_element(
            &slide_with_viewbox(),
            "slides/001.svg",
            "t1",
            &CreateTableInput {
                rows: 1.0,
                cols: 1.0,
                x: 0.0,
                y: 0.0,
                ..Default::default()
            },
            &fonts_with_default(),
        )
        .unwrap();
        let err = delete_table_column(&svg, "slides/001.svg", "t1", 0.0, &fonts_with_default())
            .unwrap_err();
        assert_eq!(err.message(), "table must have at least one column");
    }

    #[test]
    fn insert_row_then_delete_row_restores_row_count() {
        let svg = create_2x2(&slide_with_viewbox());
        let inserted =
            insert_table_row(&svg, "slides/001.svg", "t1", 1.0, &fonts_with_default()).unwrap();
        let after_insert = read_table_model(&inserted, "t1").unwrap();
        assert_eq!(after_insert.rows.len(), 3);

        let deleted = delete_table_row(
            &inserted,
            "slides/001.svg",
            "t1",
            1.0,
            &fonts_with_default(),
        )
        .unwrap();
        let after_delete = read_table_model(&deleted, "t1").unwrap();
        assert_eq!(after_delete.rows.len(), 2);
    }

    #[test]
    fn set_table_col_width_keep_total_on_last_column_errors() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = set_table_col_width(
            &svg,
            "slides/001.svg",
            "t1",
            1.0,
            200.0,
            &fonts_with_default(),
            true,
        )
        .unwrap_err();
        assert_eq!(
            err.message(),
            "--keep-total requires a column to the right to absorb the difference: last column not applicable"
        );
    }

    #[test]
    fn set_table_col_width_keep_total_below_min_errors() {
        let svg = create_2x2(&slide_with_viewbox());
        // Default col width is 160; pushing col 0 to 400 would need col 1
        // to shrink by 240, well below MIN_COL_WIDTH.
        let err = set_table_col_width(
            &svg,
            "slides/001.svg",
            "t1",
            0.0,
            400.0,
            &fonts_with_default(),
            true,
        )
        .unwrap_err();
        assert!(
            err.message()
                .contains("the right column would be smaller than the minimum column width")
        );
    }

    #[test]
    fn bind_table_source_expands_template_row_from_csv() {
        let svg = create_2x2(&slide_with_viewbox());
        let with_text = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            1.0,
            0.0,
            "{{name}}",
            &fonts_with_default(),
        )
        .unwrap();
        let csv = ParsedTableCsv {
            headers: vec!["name".to_string()],
            rows: vec![vec!["Alice".to_string()], vec!["Bob".to_string()]],
        };
        let bound = bind_table_source(
            &with_text,
            "slides/001.svg",
            "t1",
            "assets/data/people.csv",
            Some(1.0),
            &csv,
            &fonts_with_default(),
        )
        .unwrap();
        let model = read_table_model(&bound, "t1").unwrap();
        assert_eq!(model.source, Some("assets/data/people.csv".to_string()));
        // Row 0 (untouched), row 1 (template, hidden), rows 2-3 (generated).
        assert_eq!(model.rows.len(), 4);
        let generated_texts: Vec<&str> = model
            .cells
            .iter()
            .filter(|c| c.generated && c.col == 0)
            .map(|c| c.text.as_str())
            .collect();
        assert!(generated_texts.contains(&"Alice"));
        assert!(generated_texts.contains(&"Bob"));
    }

    #[test]
    fn bind_table_source_unknown_header_errors() {
        let svg = create_2x2(&slide_with_viewbox());
        let with_text = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            1.0,
            0.0,
            "{{missing}}",
            &fonts_with_default(),
        )
        .unwrap();
        let csv = ParsedTableCsv {
            headers: vec!["name".to_string()],
            rows: vec![vec!["Alice".to_string()]],
        };
        let err = bind_table_source(
            &with_text,
            "slides/001.svg",
            "t1",
            "assets/data/people.csv",
            Some(1.0),
            &csv,
            &fonts_with_default(),
        )
        .unwrap_err();
        assert!(
            err.message()
                .contains("column name not found: {{ missing }}")
        );
    }

    #[test]
    fn refresh_table_source_without_source_errors() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = refresh_table_source(
            &svg,
            "slides/001.svg",
            "t1",
            &ParsedTableCsv {
                headers: vec![],
                rows: vec![],
            },
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "table t1 has no data source");
    }

    #[test]
    fn set_table_theme_restyles_every_cell() {
        let svg = create_2x2(&slide_with_viewbox());
        let updated =
            set_table_theme(&svg, "slides/001.svg", "t1", "light", &fonts_with_default()).unwrap();
        let model = read_table_model(&updated, "t1").unwrap();
        assert_eq!(model.theme, TableTheme::Light);
        let cell = &model.cells[0];
        assert_eq!(cell.fill, "#ffffff"); // Light bg
    }

    #[test]
    fn set_table_header_restyles_row_zero() {
        let svg = create_2x2(&slide_with_viewbox());
        let updated =
            set_table_header(&svg, "slides/001.svg", "t1", true, &fonts_with_default()).unwrap();
        let model = read_table_model(&updated, "t1").unwrap();
        assert!(model.header);
    }

    #[test]
    fn set_table_from_csv_builds_header_plus_rows() {
        let svg = create_2x2(&slide_with_viewbox());
        let csv = ParsedTableCsv {
            headers: vec!["A".to_string(), "B".to_string()],
            rows: vec![vec!["1".to_string(), "2".to_string()]],
        };
        let updated =
            set_table_from_csv(&svg, "slides/001.svg", "t1", &csv, &fonts_with_default()).unwrap();
        let model = read_table_model(&updated, "t1").unwrap();
        assert!(model.header);
        assert_eq!(model.rows.len(), 2);
        assert_eq!(
            model
                .cells
                .iter()
                .find(|c| c.row == 0 && c.col == 0)
                .unwrap()
                .text,
            "A"
        );
        assert_eq!(
            model
                .cells
                .iter()
                .find(|c| c.row == 1 && c.col == 0)
                .unwrap()
                .text,
            "1"
        );
    }

    #[test]
    fn set_table_cell_style_fill_none_is_legal() {
        let svg = create_2x2(&slide_with_viewbox());
        let updated = set_table_cell_style(
            &svg,
            "slides/001.svg",
            "t1",
            SetCellStyleInput {
                row: 0.0,
                col: 0.0,
                row_end: None,
                col_end: None,
                attr: "fill".to_string(),
                value: "none".to_string(),
            },
            &fonts_with_default(),
        )
        .unwrap();
        let model = read_table_model(&updated, "t1").unwrap();
        assert_eq!(model.cells[0].fill, "none");
    }

    #[test]
    fn set_table_cell_style_invalid_fill_errors() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = set_table_cell_style(
            &svg,
            "slides/001.svg",
            "t1",
            SetCellStyleInput {
                row: 0.0,
                col: 0.0,
                row_end: None,
                col_end: None,
                attr: "fill".to_string(),
                value: "red".to_string(),
            },
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "fill must be none or #RRGGBB: red");
    }

    #[test]
    fn set_table_cell_style_text_fill_uses_model_error_message() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = set_table_cell_style(
            &svg,
            "slides/001.svg",
            "t1",
            SetCellStyleInput {
                row: 0.0,
                col: 0.0,
                row_end: None,
                col_end: None,
                attr: "text-fill".to_string(),
                value: "none".to_string(),
            },
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "text-fill must be #RRGGBB: none");
    }

    #[test]
    fn set_table_cell_style_range_out_of_bounds_matches_nothing() {
        let svg = create_2x2(&slide_with_viewbox());
        let err = set_table_cell_style(
            &svg,
            "slides/001.svg",
            "t1",
            SetCellStyleInput {
                row: 5.0,
                col: 5.0,
                row_end: None,
                col_end: None,
                attr: "align".to_string(),
                value: "center".to_string(),
            },
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "no cells in the specified range");
    }
}
