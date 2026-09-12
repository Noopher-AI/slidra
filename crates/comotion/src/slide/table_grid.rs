//! `TableGrid` plus `describeTableShapeProblem`, ported from
//! `packages/core/src/table/model.ts` — but deliberately NOT the whole of
//! that file. `table/model.ts` also owns `TableModel` (cells, header, theme,
//! source, span coverage, `readTableModel`/`validateTableModel`) — the rich,
//! editable table model. That is out of scope here (a later ticket, "F5",
//! owns it) because nothing this ticket's callers need (`geometry/bbox.rs`'s
//! table-bbox case, confirmed by reading `bbox.ts` itself) touches anything
//! beyond a table container's declared column/row grid-line positions.
//!
//! `TableGrid` is a locked public contract: future tickets may only ADD
//! fields to it, never rename or retype `cols`/`rows`. Keep it exactly this
//! shape even if `table/model.ts`'s richer `TableModel` looks like a more
//! "complete" port — that completeness is intentionally deferred.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::scan::{ScannedNode, attribute_of, attribute_value};

/// `data-comot-type="table"`'s value (`TABLE_CONTAINER_TYPE` in the TS
/// source). `slide/format.rs` re-exports this rather than duplicating the
/// literal, mirroring `slide/format.ts`'s own `export { TABLE_CONTAINER_TYPE }`
/// re-export from this same module.
pub const TABLE_CONTAINER_TYPE: &str = "table";

/// The one non-cell child a table container may carry, binding it to a CSV
/// data source. Only its presence/count matters for the structural check
/// below — its own attributes are `readTableModel`'s job (out of scope).
const TABLE_SOURCE_TAG: &str = "comot:source";

/// A table container's grid geometry: column widths and row heights, user
/// units, in document order. This is *only* what `geometry/bbox.ts` reads
/// off `element.table` (`.cols`/`.rows`, both `number[]`) to compute a
/// table's bounding box — confirmed by reading that file directly, not
/// assumed. See this module's header comment for why it stops here.
#[derive(Debug, Clone, PartialEq)]
pub struct TableGrid {
    /// Column widths, user units, left to right.
    pub cols: Vec<f64>,
    /// Row heights, user units, top to bottom.
    pub rows: Vec<f64>,
}

/// Mirrors `Number.isFinite(Number(token))`, the exact check
/// `describeTableShapeProblem`/`parseNumberList` run per whitespace-split
/// token in `data-comot-cols`/`data-comot-rows`.
///
/// KNOWN GAP (flagged, not silently assumed away — matches this codebase's
/// own convention, see `svgnum.rs`'s KNOWN GAP note): JS's `Number()` string
/// coercion additionally accepts a hexadecimal integer literal ("0x10" -> 16
/// -> finite -> accepted), which Rust's `f64::parse` rejects outright. Every
/// real `data-comot-cols`/`-rows` value this codebase ever writes is a plain
/// decimal list produced by `format_svg_number`, so this divergence is
/// believed unreachable on real documents.
fn is_finite_number_token(token: &str) -> bool {
    token
        .parse::<f64>()
        .map(|value| value.is_finite())
        .unwrap_or(false)
}

/// Matches the regex `^(\d+),(\d+)$` used by the cell address check.
/// `u128` (rather than `usize`) keeps an absurdly long digit
/// string from overflowing into a parse failure that would misreport as
/// "格式錯誤" instead of "超出表格範圍" — JS's `Number()` would instead
/// silently lose precision on such a string and still produce *a* number,
/// which then almost always compares as out-of-range; `u128` reaches the
/// same practical outcome without trying to reproduce IEEE-754 double
/// rounding here.
fn parse_cell_address(raw: &str) -> Option<(u128, u128)> {
    let (row_str, col_str) = raw.split_once(',')?;
    if row_str.is_empty() || col_str.is_empty() {
        return None;
    }
    if !row_str.bytes().all(|b| b.is_ascii_digit()) || !col_str.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((row_str.parse().ok()?, col_str.parse().ok()?))
}

/// The STRUCTURAL half of table validity — what `slide/format.rs`'s
/// `check_slide_compliance` needs to decide `InvalidTableShape` without
/// fully parsing cell content (compliance is about structure only, per
/// `slide/format.ts`'s own header comment). Returns a description of the
/// first problem found, or `None` when the shape is fine. Deeper checks
/// (grid coverage, span overlap) belong to the full `TableModel`'s
/// `validateTableModel` — out of scope here (see module header comment).
pub fn describe_table_shape_problem(container: &ScannedNode) -> Option<String> {
    let cols_raw = attribute_of(container, "data-comot-cols").map(|a| a.value.as_str());
    let rows_raw = attribute_of(container, "data-comot-rows").map(|a| a.value.as_str());
    let (cols_raw, rows_raw) = match (cols_raw, rows_raw) {
        (Some(c), Some(r)) => (c, r),
        _ => return Some("表格容器缺少 data-comot-cols 或 data-comot-rows".to_string()),
    };

    let cols: Vec<&str> = cols_raw.split_whitespace().collect();
    let rows: Vec<&str> = rows_raw.split_whitespace().collect();
    if cols.is_empty() || cols.iter().any(|token| !is_finite_number_token(token)) {
        return Some("data-comot-cols 不是合法的數字列表".to_string());
    }
    if rows.is_empty() || rows.iter().any(|token| !is_finite_number_token(token)) {
        return Some("data-comot-rows 不是合法的數字列表".to_string());
    }

    let source_count = container
        .children
        .iter()
        .filter(|child| child.tag == TABLE_SOURCE_TAG)
        .count();
    if source_count > 1 {
        return Some(format!("表格容器必須恰好包含一個 <{TABLE_SOURCE_TAG}>"));
    }

    let first_non_cell = container.children.iter().find(|child| {
        child.tag != TABLE_SOURCE_TAG && attribute_of(child, "data-comot-cell").is_none()
    });
    if let Some(offender) = first_non_cell {
        return Some(format!("表格容器不可含有非儲存格的 <{}>", offender.tag));
    }

    let cell_nodes = container
        .children
        .iter()
        .filter(|child| attribute_of(child, "data-comot-cell").is_some());
    for cell_node in cell_nodes {
        if cell_node.tag != "g" {
            return Some("儲存格必須是 <g> 容器".to_string());
        }
        let address = attribute_of(cell_node, "data-comot-cell")
            .expect("just filtered on this attribute existing")
            .value
            .as_str();
        let (row, col) = match parse_cell_address(address) {
            Some(rc) => rc,
            None => return Some(format!("data-comot-cell 格式錯誤：{address}")),
        };
        if row >= rows.len() as u128 || col >= cols.len() as u128 {
            return Some(format!("儲存格 ({row},{col}) 超出表格範圍"));
        }
        if cell_node
            .children
            .iter()
            .any(|grandchild| grandchild.tag == "g")
        {
            return Some(format!("儲存格 ({row},{col}) 內不可含有子 <g>"));
        }
    }

    None
}

/// Mirrors `parseNumberList`'s per-token validation exactly (see
/// `is_finite_number_token`'s doc comment for the one known divergence).
fn parse_number_list(raw: &str, element_id: &str, attr: &str) -> CoMotionResult<Vec<f64>> {
    raw.split_whitespace()
        .map(|token| {
            token
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .ok_or_else(|| {
                    CoMotionError::invalid(format!("元素 {element_id} 的 {attr} 含非數字：{token}"))
                })
        })
        .collect()
}

/// Extracts just the grid geometry (`cols`/`rows`) a table container needs
/// for bounding-box computation. Callers are expected to run this only after
/// `describe_table_shape_problem` (via `assert_slide_compliant`) already
/// confirmed the container has well-formed `data-comot-cols`/`-rows` — this
/// function re-validates independently anyway (never trusts a caller's
/// unstated assumption), so it still returns a clean `CoMotionError` rather
/// than panicking if that invariant is ever violated.
pub fn read_table_grid(container: &ScannedNode, element_id: &str) -> CoMotionResult<TableGrid> {
    let cols_raw = attribute_value(container, "data-comot-cols")
        .ok_or_else(|| CoMotionError::invalid(format!("元素 {element_id} 缺少 data-comot-cols")))?;
    let rows_raw = attribute_value(container, "data-comot-rows")
        .ok_or_else(|| CoMotionError::invalid(format!("元素 {element_id} 缺少 data-comot-rows")))?;
    let cols = parse_number_list(&cols_raw, element_id, "data-comot-cols")?;
    let rows = parse_number_list(&rows_raw, element_id, "data-comot-rows")?;
    Ok(TableGrid { cols, rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slide::scan::scan_document;

    fn table_container(svg: &str) -> ScannedNode {
        let mut roots = scan_document(svg).expect("test fixture must scan");
        roots.remove(0)
    }

    #[test]
    fn valid_table_shape_has_no_problem() {
        let svg = r#"<g id="t1" data-comot-type="table" data-comot-cols="100 100" data-comot-rows="40 40">
            <comot:source src="assets/data/x.csv"/>
            <g data-comot-cell="0,0"><rect/></g>
            <g data-comot-cell="0,1"><rect/></g>
            <g data-comot-cell="1,0"><rect/></g>
            <g data-comot-cell="1,1"><rect/></g>
        </g>"#;
        let container = table_container(svg);
        assert_eq!(describe_table_shape_problem(&container), None);
    }

    #[test]
    fn missing_cols_or_rows_is_a_problem() {
        let svg = r#"<g id="t1" data-comot-type="table" data-comot-rows="40 40"><g data-comot-cell="0,0"><rect/></g></g>"#;
        let container = table_container(svg);
        assert_eq!(
            describe_table_shape_problem(&container),
            Some("表格容器缺少 data-comot-cols 或 data-comot-rows".to_string())
        );
    }

    #[test]
    fn non_numeric_cols_is_a_problem() {
        let svg = r#"<g id="t1" data-comot-type="table" data-comot-cols="a b" data-comot-rows="40"><g data-comot-cell="0,0"><rect/></g></g>"#;
        let container = table_container(svg);
        assert_eq!(
            describe_table_shape_problem(&container),
            Some("data-comot-cols 不是合法的數字列表".to_string())
        );
    }

    #[test]
    fn cell_out_of_range_is_a_problem() {
        let svg = r#"<g id="t1" data-comot-type="table" data-comot-cols="100" data-comot-rows="40"><g data-comot-cell="0,5"><rect/></g></g>"#;
        let container = table_container(svg);
        assert_eq!(
            describe_table_shape_problem(&container),
            Some("儲存格 (0,5) 超出表格範圍".to_string())
        );
    }

    #[test]
    fn non_cell_child_is_a_problem() {
        let svg = r#"<g id="t1" data-comot-type="table" data-comot-cols="100" data-comot-rows="40"><rect/></g>"#;
        let container = table_container(svg);
        assert_eq!(
            describe_table_shape_problem(&container),
            Some("表格容器不可含有非儲存格的 <rect>".to_string())
        );
    }

    #[test]
    fn read_table_grid_extracts_cols_and_rows() {
        let svg = r#"<g id="t1" data-comot-type="table" data-comot-cols="100 200.5" data-comot-rows="40 60"><g data-comot-cell="0,0"><rect/></g></g>"#;
        let container = table_container(svg);
        let grid = read_table_grid(&container, "t1").unwrap();
        assert_eq!(
            grid,
            TableGrid {
                cols: vec![100.0, 200.5],
                rows: vec![40.0, 60.0]
            }
        );
    }

    #[test]
    fn read_table_grid_missing_attribute_errors() {
        let svg = r#"<g id="t1" data-comot-type="table" data-comot-rows="40"><g data-comot-cell="0,0"><rect/></g></g>"#;
        let container = table_container(svg);
        let err = read_table_grid(&container, "t1").unwrap_err();
        assert!(err.message().contains("缺少 data-comot-cols"));
    }
}
