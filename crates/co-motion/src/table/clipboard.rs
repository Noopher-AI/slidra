//! `table cell copy / cut / paste`, ported from
//! `packages/core/src/table-clipboard.ts` (147 lines) — a sibling file to
//! `table/` in the TS tree (kept out of `core/src/table/**` so the TSV
//! exchange format stays separate from the model/edit code; mirrored here
//! at the crate root's `table::clipboard`, one level under `table` rather
//! than a true sibling of it, since Rust module paths don't have an easy
//! "sibling of a directory" shape — the separation this file's doc comment
//! cares about is "not mixed into `model.rs`/`edit.rs`", which holding a
//! distinct file achieves either way).
//!
//! Reads go through `read_table_model` (which reassembles a cell's
//! `<tspan>`s back into plain text); writes go through
//! `edit::set_table_cell_texts` (which re-derives and re-renders the whole
//! container, the same way every other `table` command writes — the
//! clipboard never splices `<text>` content by hand).

use std::collections::HashMap;

use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::format::assert_slide_compliant;
use crate::text::font::ParsedFont;

use super::edit::set_table_cell_texts;
use super::model::{TableCell, TableModel, read_table_model};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRange {
    pub top: usize,
    pub left: usize,
    pub bottom: usize,
    pub right: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellAnchor {
    pub row: usize,
    pub col: usize,
}

/// `^(\d+),(\d+):(\d+),(\d+)$` hand-written (no `regex` crate). Parses
/// `--range r,c:r,c` (CLI's `table cell copy/cut`). A reversed range
/// (`3,3:1,1`) is legal and gets normalised, not rejected.
pub fn parse_cell_range(raw: &str) -> CoMotionResult<CellRange> {
    let trimmed = raw.trim();
    let fail = || {
        CoMotionError::invalid(format!(
            "--range 格式錯誤，必須是 r,c:r,c（非負整數）：{raw}"
        ))
    };
    let (first, second) = trimmed.split_once(':').ok_or_else(fail)?;
    let (r1, c1) = parse_nonneg_pair(first).ok_or_else(fail)?;
    let (r2, c2) = parse_nonneg_pair(second).ok_or_else(fail)?;
    Ok(CellRange {
        top: r1.min(r2),
        left: c1.min(c2),
        bottom: r1.max(r2),
        right: c1.max(c2),
    })
}

/// `^(\d+),(\d+)$` hand-written (no `regex` crate). Parses `--at r,c`
/// (CLI's `table cell paste`).
pub fn parse_cell_anchor(raw: &str) -> CoMotionResult<CellAnchor> {
    let trimmed = raw.trim();
    let (row, col) = parse_nonneg_pair(trimmed).ok_or_else(|| {
        CoMotionError::invalid(format!("--at 格式錯誤，必須是 r,c（非負整數）：{raw}"))
    })?;
    Ok(CellAnchor { row, col })
}

fn parse_nonneg_pair(raw: &str) -> Option<(usize, usize)> {
    let (a, b) = raw.split_once(',')?;
    let valid = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !valid(a) || !valid(b) {
        return None;
    }
    Some((a.parse().ok()?, b.parse().ok()?))
}

fn cell_at(model: &TableModel, row: usize, col: usize) -> Option<&TableCell> {
    model
        .cells
        .iter()
        .find(|cell| cell.row == row && cell.col == col)
}

fn require_range_within_bounds(range: &CellRange, model: &TableModel) -> CoMotionResult<()> {
    let rows = model.rows.len();
    let cols = model.cols.len();
    if range.bottom >= rows || range.right >= cols {
        return Err(CoMotionError::invalid(format!(
            "--range 超出表格實際列／欄數（表格為 {rows} 列 {cols} 欄）"
        )));
    }
    Ok(())
}

/// `table cell copy` — reads `range` into a TSV string. Never mutates
/// `svg_content`. A span-covered position reads as an empty cell.
pub fn copy_table_cell_range(
    svg_content: &str,
    slide_path: &str,
    table_element_id: &str,
    range: &CellRange,
) -> CoMotionResult<String> {
    assert_slide_compliant(svg_content, slide_path)?;
    let model = read_table_model(svg_content, table_element_id)?;
    require_range_within_bounds(range, &model)?;

    let mut lines = Vec::with_capacity(range.bottom - range.top + 1);
    for r in range.top..=range.bottom {
        let mut row_values = Vec::with_capacity(range.right - range.left + 1);
        for c in range.left..=range.right {
            row_values.push(
                cell_at(&model, r, c)
                    .map(|cell| cell.text.as_str())
                    .unwrap_or(""),
            );
        }
        lines.push(row_values.join("\t"));
    }
    Ok(lines.join("\n"))
}

#[derive(Debug)]
pub struct CutResult {
    pub tsv: String,
    pub updated: String,
}

/// `table cell cut` — same read as `copy_table_cell_range`, then clears
/// every cell in `range` (text only; the cell and its styling stay). One
/// `write_presentation_file` call by the caller = one undo step.
pub fn cut_table_cell_range(
    svg_content: &str,
    slide_path: &str,
    table_element_id: &str,
    range: &CellRange,
    fonts: &HashMap<String, ParsedFont>,
) -> CoMotionResult<CutResult> {
    let tsv = copy_table_cell_range(svg_content, slide_path, table_element_id, range)?;
    let model = read_table_model(svg_content, table_element_id)?;

    let mut entries = Vec::new();
    for r in range.top..=range.bottom {
        for c in range.left..=range.right {
            if cell_at(&model, r, c).is_some() {
                entries.push((r, c, String::new()));
            }
        }
    }
    let updated = if entries.is_empty() {
        svg_content.to_string()
    } else {
        set_table_cell_texts(svg_content, slide_path, table_element_id, &entries, fonts)?
    };
    Ok(CutResult { tsv, updated })
}

#[derive(Debug)]
pub struct PasteResult {
    pub updated: String,
    pub cells: usize,
}

/// `table cell paste` — writes `tsv` starting at `anchor`, clipped to the
/// table's actual bounds (never expands the table). Ragged rows are legal:
/// a short row is padded with empty cells up to the TSV's own widest row,
/// not left with whatever text the target cell already had.
pub fn paste_table_cell_range(
    svg_content: &str,
    slide_path: &str,
    table_element_id: &str,
    anchor: &CellAnchor,
    tsv: &str,
    fonts: &HashMap<String, ParsedFont>,
) -> CoMotionResult<PasteResult> {
    assert_slide_compliant(svg_content, slide_path)?;
    if tsv.is_empty() {
        return Err(CoMotionError::invalid("沒有可貼上的內容"));
    }

    let model = read_table_model(svg_content, table_element_id)?;
    let rows = model.rows.len();
    let cols = model.cols.len();
    if anchor.row >= rows || anchor.col >= cols {
        return Err(CoMotionError::invalid(format!(
            "--at 超出表格實際列／欄數（表格為 {rows} 列 {cols} 欄）"
        )));
    }

    let tsv_rows: Vec<Vec<&str>> = tsv
        .split('\n')
        .map(|line| line.split('\t').collect())
        .collect();
    let tsv_width = tsv_rows.iter().map(|row| row.len()).max().unwrap_or(0);
    let row_span = tsv_rows.len().min(rows - anchor.row);
    let col_span = tsv_width.min(cols - anchor.col);

    let mut entries = Vec::new();
    for (i, tsv_row) in tsv_rows.iter().enumerate().take(row_span) {
        for j in 0..col_span {
            let r = anchor.row + i;
            let c = anchor.col + j;
            if cell_at(&model, r, c).is_none() {
                continue;
            }
            let text = tsv_row.get(j).copied().unwrap_or("").to_string();
            entries.push((r, c, text));
        }
    }
    let cells = entries.len();
    let updated = if entries.is_empty() {
        svg_content.to_string()
    } else {
        set_table_cell_texts(svg_content, slide_path, table_element_id, &entries, fonts)?
    };
    Ok(PasteResult { updated, cells })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::edit::{CreateTableInput, create_table_element, set_table_cell_text};
    use crate::text::font::{DEFAULT_FONT_BYTES, DEFAULT_FONT_FAMILY, parse_font};

    fn fonts_with_default() -> HashMap<String, ParsedFont> {
        let mut book = HashMap::new();
        book.insert(
            DEFAULT_FONT_FAMILY.to_string(),
            parse_font(DEFAULT_FONT_BYTES).unwrap(),
        );
        book
    }

    fn create_2x2() -> String {
        create_table_element(
            r#"<svg viewBox="0 0 1280 720"></svg>"#,
            "slides/001.svg",
            "t1",
            &CreateTableInput {
                rows: 2.0,
                cols: 2.0,
                x: 0.0,
                y: 0.0,
                col_width: None,
                theme: None,
                header: Some(false),
            },
            &fonts_with_default(),
        )
        .unwrap()
    }

    #[test]
    fn parse_cell_range_normalizes_reversed_range() {
        let range = parse_cell_range("3,3:1,1").unwrap();
        assert_eq!(
            range,
            CellRange {
                top: 1,
                left: 1,
                bottom: 3,
                right: 3
            }
        );
    }

    #[test]
    fn parse_cell_range_rejects_malformed_input() {
        let err = parse_cell_range("nope").unwrap_err();
        assert!(err.message().contains("--range 格式錯誤"));
    }

    #[test]
    fn parse_cell_anchor_parses_simple_pair() {
        let anchor = parse_cell_anchor("2,3").unwrap();
        assert_eq!(anchor, CellAnchor { row: 2, col: 3 });
    }

    #[test]
    fn copy_reads_tsv_without_mutating() {
        let svg = create_2x2();
        let with_text = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            0,
            0,
            "A",
            &fonts_with_default(),
        )
        .unwrap();
        let with_text = set_table_cell_text(
            &with_text,
            "slides/001.svg",
            "t1",
            0,
            1,
            "B",
            &fonts_with_default(),
        )
        .unwrap();
        let tsv = copy_table_cell_range(
            &with_text,
            "slides/001.svg",
            "t1",
            &CellRange {
                top: 0,
                left: 0,
                bottom: 0,
                right: 1,
            },
        )
        .unwrap();
        assert_eq!(tsv, "A\tB");
    }

    #[test]
    fn copy_out_of_bounds_range_errors() {
        let svg = create_2x2();
        let err = copy_table_cell_range(
            &svg,
            "slides/001.svg",
            "t1",
            &CellRange {
                top: 0,
                left: 0,
                bottom: 5,
                right: 5,
            },
        )
        .unwrap_err();
        assert!(err.message().contains("超出表格實際列／欄數"));
    }

    #[test]
    fn cut_clears_range_and_returns_the_original_tsv() {
        let svg = create_2x2();
        let with_text = set_table_cell_text(
            &svg,
            "slides/001.svg",
            "t1",
            0,
            0,
            "A",
            &fonts_with_default(),
        )
        .unwrap();
        let result = cut_table_cell_range(
            &with_text,
            "slides/001.svg",
            "t1",
            &CellRange {
                top: 0,
                left: 0,
                bottom: 0,
                right: 0,
            },
            &fonts_with_default(),
        )
        .unwrap();
        assert_eq!(result.tsv, "A");
        let model = read_table_model(&result.updated, "t1").unwrap();
        assert_eq!(
            model
                .cells
                .iter()
                .find(|c| c.row == 0 && c.col == 0)
                .unwrap()
                .text,
            ""
        );
    }

    #[test]
    fn paste_clips_to_table_bounds_and_pads_ragged_rows() {
        let svg = create_2x2();
        let result = paste_table_cell_range(
            &svg,
            "slides/001.svg",
            "t1",
            &CellAnchor { row: 0, col: 0 },
            "A\tB\nC",
            &fonts_with_default(),
        )
        .unwrap();
        assert_eq!(result.cells, 4); // (0,0)=A (0,1)=B (1,0)=C (1,1)="" -- all four positions exist
        let model = read_table_model(&result.updated, "t1").unwrap();
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
                .find(|c| c.row == 0 && c.col == 1)
                .unwrap()
                .text,
            "B"
        );
        assert_eq!(
            model
                .cells
                .iter()
                .find(|c| c.row == 1 && c.col == 0)
                .unwrap()
                .text,
            "C"
        );
        assert_eq!(
            model
                .cells
                .iter()
                .find(|c| c.row == 1 && c.col == 1)
                .unwrap()
                .text,
            ""
        );
    }

    #[test]
    fn paste_empty_tsv_errors() {
        let svg = create_2x2();
        let err = paste_table_cell_range(
            &svg,
            "slides/001.svg",
            "t1",
            &CellAnchor { row: 0, col: 0 },
            "",
            &fonts_with_default(),
        )
        .unwrap_err();
        assert_eq!(err.message(), "沒有可貼上的內容");
    }

    #[test]
    fn paste_anchor_out_of_bounds_errors() {
        let svg = create_2x2();
        let err = paste_table_cell_range(
            &svg,
            "slides/001.svg",
            "t1",
            &CellAnchor { row: 9, col: 9 },
            "x",
            &fonts_with_default(),
        )
        .unwrap_err();
        assert!(err.message().contains("超出表格實際列／欄數"));
    }
}
