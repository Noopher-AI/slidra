// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `TableModel`/`TableCell` — the rich, editable table model (cells, header,
//! theme, source, span coverage). `crates/slidra/src/slide/table_grid.rs`
//! (read-only here) covers the SHALLOW structural half —
//! `TABLE_CONTAINER_TYPE` and `describe_table_shape_problem` — which
//! `slide/format.rs`'s `assert_slide_compliant` already runs before every
//! table command reads its container. This file does NOT re-run that
//! shallow check and does NOT redeclare `TABLE_CONTAINER_TYPE` — it `use`s
//! the table_grid.rs constant directly. What it adds is the DEEP
//! validation `describe_table_shape_problem` explicitly defers (grid
//! coverage, span overlap — see that function's own doc comment) plus the
//! full cell-content model reassembled from markup.

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value, scan_document};
pub use crate::slide::table_grid::TABLE_CONTAINER_TYPE;
use crate::svgnum::format_js_number;
use crate::text::runs::utf16_slice;
use crate::text::unescape_xml_text;

/// The one non-cell child a table container may carry, binding it to a CSV
/// data source. Matches `table_grid.rs`'s private constant of the same
/// value — that one is not `pub`, so it is redeclared here rather than
/// imported (a single string literal, not the structural-check logic the
/// module header discusses).
pub const TABLE_SOURCE_TAG: &str = "slidra:source";

/// Matches `packages/core/src/effects/index.ts`'s `EFFECTS_NS` value (the
/// TS source re-exports the SAME constant as `TABLE_NS`) — no Rust
/// `effects` module exists yet to import this from, so the literal is
/// duplicated here with this note rather than invented independently.
pub const TABLE_NS: &str = "https://slidra.app/ns/2026";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableTheme {
    Dark,
    Light,
    Zebra,
}

impl TableTheme {
    pub const ALL: [TableTheme; 3] = [TableTheme::Dark, TableTheme::Light, TableTheme::Zebra];
    pub const DOMAIN: [&'static str; 3] = ["dark", "light", "zebra"];

    pub fn as_str(self) -> &'static str {
        match self {
            TableTheme::Dark => "dark",
            TableTheme::Light => "light",
            TableTheme::Zebra => "zebra",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "dark" => Some(TableTheme::Dark),
            "light" => Some(TableTheme::Light),
            "zebra" => Some(TableTheme::Zebra),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellAlign {
    Left,
    Center,
    Right,
}

impl CellAlign {
    pub const DOMAIN: [&'static str; 3] = ["left", "center", "right"];

    pub fn as_str(self) -> &'static str {
        match self {
            CellAlign::Left => "left",
            CellAlign::Center => "center",
            CellAlign::Right => "right",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(CellAlign::Left),
            "center" => Some(CellAlign::Center),
            "right" => Some(CellAlign::Right),
            _ => None,
        }
    }
}

/// `100, 200, ..., 900` — the only legal `font-weight` values.
pub const CELL_FONT_WEIGHTS: [f64; 9] = [
    100.0, 200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0,
];

/// `Number(str)` and JS's `String(NaN|Infinity|-Infinity)` printing, shared
/// by every place in the `table` module that needs the exact same numeric
/// coercion an attribute value or CLI flag value goes through in the TS
/// source (`Number(raw)`, un-guarded by an `isFinite` check at the read
/// site — `validate_table_model` is what actually rejects a non-finite
/// result, exactly mirroring `model.ts`'s own split between "coerce" at
/// read time and "reject" at validate time).
pub(crate) fn number_coerce(raw: &str) -> f64 {
    crate::argv::parse_js_number(raw).unwrap_or(f64::NAN)
}

/// `String(number)` for a value that might be `NaN`/`+-Infinity` — used only
/// in human-readable error messages (never SVG output, where
/// `format_js_number`/`format_svg_number` are the rule and non-finite
/// values are a hard `panic!`, see `svgnum.rs`).
pub(crate) fn js_number_string(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value.is_infinite() {
        if value > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        }
    } else {
        format_js_number(value)
    }
}

/// `requireEnum` from `model.ts`: `${label} 必須是下列其中之一：{domain}（收到：{value}）`.
pub(crate) fn require_enum_error(value: &str, domain: &[&str], label: &str) -> SlidraError {
    SlidraError::invalid(format!(
        "{label} must be one of the following: {} (received: {value})",
        domain.join(", ")
    ))
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableCell {
    pub row: usize,
    pub col: usize,
    pub text: String,
    pub align: CellAlign,
    /// Native `fill` on the cell's `<rect>` — `"none"` or `#RRGGBB`.
    pub fill: String,
    /// `fill-opacity` on the cell's `<rect>`; `None` means the attribute is
    /// omitted (fully opaque).
    pub fill_opacity: Option<f64>,
    /// Native `fill` on the cell's `<text>`, always `#RRGGBB`.
    pub text_fill: String,
    pub font_weight: f64,
    pub row_span: usize,
    pub col_span: usize,
    /// `data-slidra-repeat="row"`: this cell belongs to the bound table's
    /// template row. Always paired with `display="none"`.
    pub repeat: bool,
    /// `data-slidra-generated="1"`: produced by `table bind`/`table refresh`
    /// from CSV data.
    pub generated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableModel {
    /// Column widths, user units, left to right.
    pub cols: Vec<f64>,
    /// Row heights, user units, top to bottom — always core-computed, never
    /// user-specified. A hidden template row's height is 0.
    pub rows: Vec<f64>,
    pub header: bool,
    pub theme: TableTheme,
    /// `assets/data/….csv` virtual path, or `None` when the table is not bound.
    pub source: Option<String>,
    /// Every real cell (span-covered positions are not separate entries).
    pub cells: Vec<TableCell>,
}

fn is_hex_color_6(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

pub(crate) fn require_hex_color_6(value: &str, label: &str) -> SlidraResult<()> {
    if !is_hex_color_6(value) {
        return Err(SlidraError::invalid(format!(
            "{label} must be #RRGGBB: {value}"
        )));
    }
    Ok(())
}

/// Every invariant a `TableModel` must hold before it can be rendered: the
/// grid geometry, the cell/span coverage (every row×col position covered by
/// exactly one cell), and every enum field. Called before every write.
pub fn validate_table_model(model: &TableModel) -> SlidraResult<()> {
    if model.cols.is_empty() {
        return Err(SlidraError::invalid("table must have at least one column"));
    }
    if model.rows.is_empty() {
        return Err(SlidraError::invalid("table must have at least one row"));
    }
    for width in &model.cols {
        if !width.is_finite() || *width <= 0.0 {
            return Err(SlidraError::invalid(format!(
                "column width must be a finite number greater than 0: {}",
                js_number_string(*width)
            )));
        }
    }
    for height in &model.rows {
        if !height.is_finite() || *height < 0.0 {
            return Err(SlidraError::invalid(format!(
                "row height must be a finite number not less than 0: {}",
                js_number_string(*height)
            )));
        }
    }
    if TableTheme::parse(model.theme.as_str()).is_none() {
        // Unreachable through the enum's own type safety — kept as a
        // defensive mirror of `requireEnum(model.theme, ...)`'s call in the
        // TS source, which validates a plain string field.
        return Err(require_enum_error(
            model.theme.as_str(),
            &TableTheme::DOMAIN,
            "theme",
        ));
    }

    let row_count = model.rows.len();
    let col_count = model.cols.len();
    let mut covered = vec![vec![false; col_count]; row_count];

    for cell in &model.cells {
        if cell.row_span < 1 || cell.col_span < 1 {
            return Err(SlidraError::invalid(format!(
                "cell ({},{})\'s merge range must be a positive integer",
                cell.row, cell.col
            )));
        }
        if cell.row + cell.row_span > row_count || cell.col + cell.col_span > col_count {
            return Err(SlidraError::invalid(format!(
                "cell ({},{})\'s range is out of table",
                cell.row, cell.col
            )));
        }
        if CellAlign::parse(cell.align.as_str()).is_none() {
            return Err(require_enum_error(
                cell.align.as_str(),
                &CellAlign::DOMAIN,
                &format!("cell ({},{})\'s align", cell.row, cell.col),
            ));
        }
        if !CELL_FONT_WEIGHTS.contains(&cell.font_weight) {
            return Err(SlidraError::invalid(format!(
                "cell ({},{})\'s font-weight must be a multiple of 100 between 100 and 900: {}",
                cell.row,
                cell.col,
                js_number_string(cell.font_weight)
            )));
        }
        if cell.fill != "none" && !is_hex_color_6(&cell.fill) {
            return Err(SlidraError::invalid(format!(
                "cell ({},{})\'s fill must be none or #RRGGBB: {}",
                cell.row, cell.col, cell.fill
            )));
        }
        if let Some(opacity) = cell.fill_opacity {
            if !opacity.is_finite() || !(0.0..=1.0).contains(&opacity) {
                return Err(SlidraError::invalid(format!(
                    "cell ({},{})\'s fill-opacity must be between 0 and 1",
                    cell.row, cell.col
                )));
            }
        }
        if !is_hex_color_6(&cell.text_fill) {
            return Err(SlidraError::invalid(format!(
                "cell ({},{})\'s text-fill must be #RRGGBB: {}",
                cell.row, cell.col, cell.text_fill
            )));
        }
        for row in covered.iter_mut().skip(cell.row).take(cell.row_span) {
            for is_covered in row.iter_mut().skip(cell.col).take(cell.col_span) {
                if *is_covered {
                    return Err(SlidraError::invalid(
                        "merge range overlaps with an existing merge",
                    ));
                }
                *is_covered = true;
            }
        }
    }

    for (r, row) in covered.iter().enumerate() {
        for (c, &is_covered) in row.iter().enumerate() {
            if !is_covered {
                return Err(SlidraError::invalid(format!(
                    "cell ({r},{c}) has no content, the table grid is not fully covered"
                )));
            }
        }
    }

    let mut template_rows: Vec<usize> = model
        .cells
        .iter()
        .filter(|cell| cell.repeat)
        .map(|cell| cell.row)
        .collect();
    template_rows.sort_unstable();
    template_rows.dedup();
    if template_rows.len() > 1 {
        return Err(SlidraError::invalid("template row can only have one row"));
    }

    Ok(())
}

/// Recurses only into `<g>` children — mirrors `findTableContainer`'s own
/// restriction (a table container can never be nested inside a non-`g`
/// element).
fn find_table_container<'a>(parent: &'a ScannedNode, id: &str) -> Option<&'a ScannedNode> {
    for child in &parent.children {
        if child.tag != "g" {
            continue;
        }
        if attribute_value(child, "id").as_deref() == Some(id) {
            return Some(child);
        }
        if let Some(found) = find_table_container(child, id) {
            return Some(found);
        }
    }
    None
}

/// Locates a table's container `<g>` by id within an already-scanned
/// document. `找不到元素` when absent, a distinct message when the element
/// exists but is not a table (`InvalidRequest` either way — `failed`, not
/// `not-found`, per `docs/spec/cli.md`'s per-command error tables).
pub fn require_table_container<'a>(
    roots: &'a [ScannedNode],
    element_id: &str,
) -> SlidraResult<&'a ScannedNode> {
    let svg_root = roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("root node of the slide is not <svg>"))?;
    let found = find_table_container(svg_root, element_id)
        .ok_or_else(|| SlidraError::invalid(format!("element not found: {element_id}")))?;
    if attribute_value(found, "data-slidra-type").as_deref() != Some(TABLE_CONTAINER_TYPE) {
        return Err(SlidraError::invalid(format!(
            "element {element_id} is not a table"
        )));
    }
    Ok(found)
}

fn parse_number_list(raw: &str, element_id: &str, attr: &str) -> SlidraResult<Vec<f64>> {
    raw.split_whitespace()
        .map(|token| {
            let value = number_coerce(token);
            if !value.is_finite() {
                return Err(SlidraError::invalid(format!(
                    "element {element_id}\'s {attr} contains a non-number: {token}"
                )));
            }
            Ok(value)
        })
        .collect()
}

/// Parses `r,c` (both non-negative integers, `^(\d+),(\d+)$`) — shared by
/// cell addresses (`data-slidra-cell`) and spans (`data-slidra-span`).
/// `error_message` is only ever evaluated once, on the failure path, so a
/// plain `String` (rather than a closure) is the simplest shape here.
fn parse_two_nonneg_ints(raw: &str, error_message: &str) -> SlidraResult<(usize, usize)> {
    let fail = || SlidraError::invalid(error_message.to_string());
    let Some((a_str, b_str)) = raw.split_once(',') else {
        return Err(fail());
    };
    let valid = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !valid(a_str) || !valid(b_str) {
        return Err(fail());
    }
    let a = a_str.parse::<usize>().map_err(|_| fail())?;
    let b = b_str.parse::<usize>().map_err(|_| fail())?;
    Ok((a, b))
}

fn parse_cell_address(raw: &str, element_id: &str) -> SlidraResult<(usize, usize)> {
    parse_two_nonneg_ints(
        raw,
        &format!("element {element_id}\'s cell address has invalid format: {raw}"),
    )
}

fn parse_span(raw: &str, element_id: &str) -> SlidraResult<(usize, usize)> {
    parse_two_nonneg_ints(
        raw,
        &format!("element {element_id}\'s data-slidra-span has invalid format: {raw}"),
    )
}

/// Reassembles a cell's `<text>` tspans back into plain text — the inverse
/// of `wrap_text` + `render_text_box_content`'s tspan emission. Only a
/// tspan carrying `data-slidra-break="1"` (a HARD break) gets a `\n`
/// appended after it; an ordinary soft-wrapped line is concatenated
/// directly, with no separator.
fn read_cell_text(cell_node: &ScannedNode, svg_content: &str) -> String {
    let Some(text_node) = cell_node.children.iter().find(|child| child.tag == "text") else {
        return String::new();
    };
    let tspans: Vec<&ScannedNode> = text_node
        .children
        .iter()
        .filter(|child| child.tag == "tspan")
        .collect();
    if tspans.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for tspan in tspans {
        let text = unescape_xml_text(&utf16_slice(
            svg_content,
            tspan.content_start,
            tspan.content_end,
        ));
        out.push_str(&text);
        if attribute_value(tspan, "data-slidra-break").as_deref() == Some("1") {
            out.push('\n');
        }
    }
    out
}

/// Reads `element_id`'s table container back into a `TableModel`.
/// Structural legality beyond "parses at all" is re-checked by
/// `validate_table_model` at the end, so a model this function returns is
/// always safe to hand to `layout.rs`/`render.rs`.
pub fn read_table_model(svg_content: &str, element_id: &str) -> SlidraResult<TableModel> {
    let roots = scan_document(svg_content)?;
    let container = require_table_container(&roots, element_id)?;

    let cols_raw = attribute_of(container, "data-slidra-cols").ok_or_else(|| {
        SlidraError::invalid(format!("element {element_id} is missing data-slidra-cols"))
    })?;
    let rows_raw = attribute_of(container, "data-slidra-rows").ok_or_else(|| {
        SlidraError::invalid(format!("element {element_id} is missing data-slidra-rows"))
    })?;
    let cols = parse_number_list(&cols_raw.value, element_id, "data-slidra-cols")?;
    let rows = parse_number_list(&rows_raw.value, element_id, "data-slidra-rows")?;

    let header = attribute_value(container, "data-slidra-header").as_deref() == Some("1");
    let theme_raw =
        attribute_value(container, "data-slidra-theme").unwrap_or_else(|| "dark".to_string());
    let theme = TableTheme::parse(&theme_raw).ok_or_else(|| {
        require_enum_error(
            &theme_raw,
            &TableTheme::DOMAIN,
            &format!("element {element_id}\'s data-slidra-theme"),
        )
    })?;

    let source_nodes: Vec<&ScannedNode> = container
        .children
        .iter()
        .filter(|child| child.tag == TABLE_SOURCE_TAG)
        .collect();
    if source_nodes.len() > 1 {
        return Err(SlidraError::invalid(format!(
            "element {element_id} has multiple <{TABLE_SOURCE_TAG}>"
        )));
    }
    let source = source_nodes
        .first()
        .and_then(|node| attribute_value(node, "src"));

    let cell_nodes: Vec<&ScannedNode> = container
        .children
        .iter()
        .filter(|child| attribute_of(child, "data-slidra-cell").is_some())
        .collect();
    let mut cells = Vec::with_capacity(cell_nodes.len());
    for cell_node in cell_nodes {
        let address_raw = attribute_of(cell_node, "data-slidra-cell")
            .expect("filtered on this attribute existing above")
            .value
            .clone();
        let (row, col) = parse_cell_address(&address_raw, element_id)?;
        let (row_span, col_span) = match attribute_of(cell_node, "data-slidra-span") {
            Some(attr) => parse_span(&attr.value, element_id)?,
            None => (1, 1),
        };
        let repeat = attribute_value(cell_node, "data-slidra-repeat").as_deref() == Some("row");
        let generated = attribute_value(cell_node, "data-slidra-generated").as_deref() == Some("1");

        let rect_node = cell_node.children.iter().find(|child| child.tag == "rect");
        let text_node = cell_node.children.iter().find(|child| child.tag == "text");
        let fill = rect_node
            .and_then(|node| attribute_value(node, "fill"))
            .unwrap_or_else(|| "none".to_string());
        let fill_opacity = rect_node
            .and_then(|node| attribute_value(node, "fill-opacity"))
            .map(|raw| number_coerce(&raw));
        let text_fill = text_node
            .and_then(|node| attribute_value(node, "fill"))
            .unwrap_or_else(|| "#000000".to_string());
        let font_weight = text_node
            .and_then(|node| attribute_value(node, "font-weight"))
            .map(|raw| number_coerce(&raw))
            .unwrap_or(400.0);
        let align_raw =
            attribute_value(cell_node, "data-slidra-align").unwrap_or_else(|| "left".to_string());
        let align = CellAlign::parse(&align_raw).ok_or_else(|| {
            require_enum_error(
                &align_raw,
                &CellAlign::DOMAIN,
                &format!("cell ({row},{col})\'s data-slidra-align"),
            )
        })?;

        let text = read_cell_text(cell_node, svg_content);

        cells.push(TableCell {
            row,
            col,
            text,
            align,
            fill,
            fill_opacity,
            text_fill,
            font_weight,
            row_span,
            col_span,
            repeat,
            generated,
        });
    }

    let model = TableModel {
        cols,
        rows,
        header,
        theme,
        source,
        cells,
    };
    validate_table_model(&model)?;
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_cell(row: usize, col: usize) -> TableCell {
        TableCell {
            row,
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
        }
    }

    fn grid_model(rows: usize, cols: usize) -> TableModel {
        let mut cells = Vec::new();
        for r in 0..rows {
            for c in 0..cols {
                cells.push(base_cell(r, c));
            }
        }
        TableModel {
            cols: vec![100.0; cols],
            rows: vec![40.0; rows],
            header: false,
            theme: TableTheme::Dark,
            source: None,
            cells,
        }
    }

    #[test]
    fn empty_cols_errors() {
        let mut model = grid_model(1, 1);
        model.cols.clear();
        let err = validate_table_model(&model).unwrap_err();
        assert_eq!(err.message(), "table must have at least one column");
    }

    #[test]
    fn empty_rows_errors() {
        let mut model = grid_model(1, 1);
        model.rows.clear();
        let err = validate_table_model(&model).unwrap_err();
        assert_eq!(err.message(), "table must have at least one row");
    }

    #[test]
    fn non_positive_col_width_errors() {
        let mut model = grid_model(1, 1);
        model.cols[0] = 0.0;
        let err = validate_table_model(&model).unwrap_err();
        assert!(
            err.message()
                .contains("column width must be a finite number greater than 0")
        );
    }

    #[test]
    fn negative_row_height_errors_but_zero_is_legal() {
        let mut model = grid_model(1, 1);
        model.rows[0] = -1.0;
        let err = validate_table_model(&model).unwrap_err();
        assert!(
            err.message()
                .contains("row height must be a finite number not less than 0")
        );

        let mut zero_row = grid_model(1, 1);
        zero_row.rows[0] = 0.0;
        assert!(validate_table_model(&zero_row).is_ok());
    }

    #[test]
    fn span_less_than_one_errors() {
        let mut model = grid_model(1, 1);
        model.cells[0].row_span = 0;
        let err = validate_table_model(&model).unwrap_err();
        assert!(
            err.message()
                .contains("merge range must be a positive integer")
        );
    }

    #[test]
    fn span_exceeding_bounds_errors() {
        let mut model = grid_model(1, 1);
        model.cells[0].col_span = 2;
        let err = validate_table_model(&model).unwrap_err();
        assert!(err.message().contains("range is out of table"));
    }

    #[test]
    fn overlapping_spans_error() {
        let mut model = grid_model(2, 2);
        // Cover the whole grid with one 2x2 cell, then add another cell at
        // (0,0) that overlaps it.
        model.cells = vec![TableCell {
            row_span: 2,
            col_span: 2,
            ..base_cell(0, 0)
        }];
        model.cells.push(base_cell(0, 0));
        let err = validate_table_model(&model).unwrap_err();
        assert_eq!(err.message(), "merge range overlaps with an existing merge");
    }

    #[test]
    fn incomplete_grid_coverage_errors() {
        let mut model = grid_model(2, 2);
        model.cells.pop();
        let err = validate_table_model(&model).unwrap_err();
        assert!(
            err.message()
                .contains("no content, the table grid is not fully covered")
        );
    }

    #[test]
    fn font_weight_not_a_multiple_of_100_errors() {
        let mut model = grid_model(1, 1);
        model.cells[0].font_weight = 450.0;
        let err = validate_table_model(&model).unwrap_err();
        assert!(
            err.message()
                .contains("font-weight must be a multiple of 100 between 100 and 900")
        );
    }

    #[test]
    fn fill_must_be_none_or_six_digit_hex() {
        let mut model = grid_model(1, 1);
        model.cells[0].fill = "#abc".to_string();
        let err = validate_table_model(&model).unwrap_err();
        assert!(err.message().contains("fill must be none or #RRGGBB"));

        let mut ok_model = grid_model(1, 1);
        ok_model.cells[0].fill = "#aabbcc".to_string();
        assert!(validate_table_model(&ok_model).is_ok());
    }

    #[test]
    fn fill_opacity_out_of_range_errors() {
        let mut model = grid_model(1, 1);
        model.cells[0].fill_opacity = Some(1.5);
        let err = validate_table_model(&model).unwrap_err();
        assert!(
            err.message()
                .contains("fill-opacity must be between 0 and 1")
        );
    }

    #[test]
    fn text_fill_must_be_six_digit_hex() {
        let mut model = grid_model(1, 1);
        model.cells[0].text_fill = "none".to_string();
        let err = validate_table_model(&model).unwrap_err();
        assert!(err.message().contains("text-fill must be #RRGGBB"));
    }

    #[test]
    fn more_than_one_template_row_errors() {
        let mut model = grid_model(2, 1);
        model.cells[0].repeat = true;
        model.cells[1].repeat = true;
        let err = validate_table_model(&model).unwrap_err();
        assert_eq!(err.message(), "template row can only have one row");
    }

    #[test]
    fn read_table_model_defaults_theme_and_header_when_attributes_missing() {
        let svg = r##"<svg viewBox="0 0 100 100"><g id="t1" data-slidra-type="table" data-slidra-cols="100" data-slidra-rows="40">
            <g data-slidra-cell="0,0"><rect fill="none"/><text fill="#000000" font-weight="400"></text></g>
        </g></svg>"##;
        let model = read_table_model(svg, "t1").unwrap();
        assert_eq!(model.theme, TableTheme::Dark);
        assert!(!model.header);
        assert_eq!(model.cells[0].text, "");
        assert_eq!(model.cells[0].text_fill, "#000000");
        assert_eq!(model.cells[0].font_weight, 400.0);
    }

    #[test]
    fn read_table_model_header_only_true_for_literal_one() {
        let svg = r##"<svg viewBox="0 0 100 100"><g id="t1" data-slidra-type="table" data-slidra-cols="100" data-slidra-rows="40" data-slidra-header="yes">
            <g data-slidra-cell="0,0"><rect fill="none"/><text fill="#000000" font-weight="400"></text></g>
        </g></svg>"##;
        let model = read_table_model(svg, "t1").unwrap();
        assert!(!model.header);
    }

    #[test]
    fn read_table_model_multiple_source_nodes_errors() {
        let svg = r##"<svg viewBox="0 0 100 100"><g id="t1" data-slidra-type="table" data-slidra-cols="100" data-slidra-rows="40">
            <slidra:source src="a.csv"/><slidra:source src="b.csv"/>
            <g data-slidra-cell="0,0"><rect fill="none"/><text fill="#000000" font-weight="400"></text></g>
        </g></svg>"##;
        let err = read_table_model(svg, "t1").unwrap_err();
        assert!(err.message().contains("multiple <slidra:source>"));
    }

    #[test]
    fn read_table_model_reassembles_hard_break_text() {
        let svg = "<svg viewBox=\"0 0 100 100\"><g id=\"t1\" data-slidra-type=\"table\" data-slidra-cols=\"100\" data-slidra-rows=\"40\">\
            <g data-slidra-cell=\"0,0\"><rect fill=\"none\"/><text fill=\"#000000\" font-weight=\"400\">\
            <tspan x=\"0\" y=\"10\" data-slidra-break=\"1\">line one</tspan><tspan x=\"0\" y=\"20\">line two</tspan>\
            </text></g></g></svg>";
        let model = read_table_model(svg, "t1").unwrap();
        assert_eq!(model.cells[0].text, "line one\nline two");
    }

    #[test]
    fn require_table_container_missing_element_errors() {
        let svg = r#"<svg viewBox="0 0 100 100"></svg>"#;
        let roots = scan_document(svg).unwrap();
        let err = require_table_container(&roots, "el-nope").unwrap_err();
        assert_eq!(err.message(), "element not found: el-nope");
    }

    #[test]
    fn require_table_container_wrong_type_errors() {
        let svg = r#"<svg viewBox="0 0 100 100"><g id="el-1" data-slidra-type="chart"></g></svg>"#;
        let roots = scan_document(svg).unwrap();
        let err = require_table_container(&roots, "el-1").unwrap_err();
        assert_eq!(err.message(), "element el-1 is not a table");
    }
}
