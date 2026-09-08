//! `renderTableMarkup`, ported from `packages/core/src/table/render.ts` (76
//! lines, ported in full).
//!
//! Serializes a `TableModel` into the full `<g data-comot-type="table">…</g>`
//! markup. A pure function: `table/edit.rs`'s every write re-renders the
//! WHOLE container and splices it in place of the old one — row heights,
//! cell geometry, and every baked colour always agree with the model that
//! produced them, never a stale partial patch.

use std::collections::HashMap;

use crate::errors::CoMotionResult;
use crate::svgnum::format_svg_number;
use crate::text::escape_xml_attr;
use crate::text::font::ParsedFont;
use crate::text::render::render_text_box_content;
use crate::text::wrap::WrappedLine;

use super::layout::{CELL_PADDING_X, CELL_PADDING_Y, CellLayout, compute_table_layout};
use super::model::{TABLE_CONTAINER_TYPE, TABLE_NS, TABLE_SOURCE_TAG, TableModel};

pub fn render_table_markup(
    model: &TableModel,
    element_id: &str,
    transform: Option<&str>,
    fonts: &HashMap<String, ParsedFont>,
) -> CoMotionResult<String> {
    let layout = compute_table_layout(model, fonts)?;

    let cols_attr = model
        .cols
        .iter()
        .map(|value| format_svg_number(*value))
        .collect::<Vec<_>>()
        .join(" ");
    let rows_attr = layout
        .rows
        .iter()
        .map(|value| format_svg_number(*value))
        .collect::<Vec<_>>()
        .join(" ");
    let header_attr = if model.header {
        " data-comot-header=\"1\""
    } else {
        ""
    };
    let transform_attr = match transform {
        Some(value) => format!(" transform=\"{}\"", escape_xml_attr(value)),
        None => String::new(),
    };
    let source_markup = match &model.source {
        Some(source) => format!(
            "<{TABLE_SOURCE_TAG} xmlns:comot=\"{TABLE_NS}\" src=\"{}\"/>",
            escape_xml_attr(source)
        ),
        None => String::new(),
    };

    let mut sorted_cells: Vec<&CellLayout> = layout.cells.iter().collect();
    sorted_cells.sort_by(|a, b| {
        a.cell
            .row
            .cmp(&b.cell.row)
            .then(a.cell.col.cmp(&b.cell.col))
    });
    let cells_markup: String = sorted_cells
        .iter()
        .map(|cell_layout| render_cell_markup(cell_layout))
        .collect();

    Ok(format!(
        "<g id=\"{}\" data-comot-type=\"{TABLE_CONTAINER_TYPE}\" data-comot-cols=\"{cols_attr}\" data-comot-rows=\"{rows_attr}\"{header_attr} data-comot-theme=\"{}\"{transform_attr}>{source_markup}{cells_markup}</g>",
        escape_xml_attr(element_id),
        model.theme.as_str(),
    ))
}

fn render_cell_markup(layout: &CellLayout) -> String {
    let cell = &layout.cell;
    let span_attr = if cell.row_span > 1 || cell.col_span > 1 {
        format!(" data-comot-span=\"{},{}\"", cell.row_span, cell.col_span)
    } else {
        String::new()
    };
    let repeat_attr = if cell.repeat {
        " data-comot-repeat=\"row\" display=\"none\""
    } else {
        ""
    };
    let generated_attr = if cell.generated {
        " data-comot-generated=\"1\""
    } else {
        ""
    };
    let align_attr = if cell.align.as_str() != "left" {
        format!(" data-comot-align=\"{}\"", cell.align.as_str())
    } else {
        String::new()
    };
    let cell_transform = format!(
        " transform=\"translate({} {})\"",
        format_svg_number(layout.x),
        format_svg_number(layout.y)
    );

    let fill_opacity_attr = match cell.fill_opacity {
        Some(opacity) => format!(" fill-opacity=\"{}\"", format_svg_number(opacity)),
        None => String::new(),
    };
    // `pointer-events="all"` is required, not cosmetic: SVG's default
    // hit-testing model never hit-tests a shape whose own fill is "none" —
    // exactly the dark theme's non-header/non-zebra rows — so without this,
    // a click on such a cell falls through to whatever sits behind the
    // table.
    let rect = format!(
        "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"{}\"{fill_opacity_attr} pointer-events=\"all\"/>",
        format_svg_number(layout.width),
        format_svg_number(layout.height),
        escape_xml_attr(&cell.fill),
    );

    let content_lines: Vec<WrappedLine> = layout
        .wrapped
        .lines
        .iter()
        .map(|line| WrappedLine {
            x: line.x + CELL_PADDING_X,
            y: line.y + CELL_PADDING_Y,
            ..line.clone()
        })
        .collect();
    let first_line = &content_lines[0];
    let text_x = first_line.x;
    let text_y = first_line.y;
    let content = render_text_box_content(&content_lines, &[]);
    let text = format!(
        "<text x=\"{}\" y=\"{}\" font-size=\"{}\" font-weight=\"{}\" fill=\"{}\" xml:space=\"preserve\">{content}</text>",
        format_svg_number(text_x),
        format_svg_number(text_y),
        format_svg_number(layout.font_size),
        format_svg_number(cell.font_weight),
        escape_xml_attr(&cell.text_fill),
    );

    format!(
        "<g data-comot-cell=\"{},{}\"{span_attr}{repeat_attr}{generated_attr}{align_attr}{cell_transform}>{rect}{text}</g>",
        cell.row, cell.col,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::model::{CellAlign, TableCell, TableTheme};
    use crate::text::font::{DEFAULT_FONT_BYTES, DEFAULT_FONT_FAMILY, parse_font};

    fn fonts_with_default() -> HashMap<String, ParsedFont> {
        let mut book = HashMap::new();
        book.insert(
            DEFAULT_FONT_FAMILY.to_string(),
            parse_font(DEFAULT_FONT_BYTES).unwrap(),
        );
        book
    }

    fn cell(row: usize, col: usize) -> TableCell {
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

    fn one_cell_model() -> TableModel {
        TableModel {
            cols: vec![100.0],
            rows: vec![0.0],
            header: false,
            theme: TableTheme::Dark,
            source: None,
            cells: vec![cell(0, 0)],
        }
    }

    #[test]
    fn renders_container_with_cols_rows_and_theme() {
        let model = one_cell_model();
        let markup = render_table_markup(&model, "el-1", None, &fonts_with_default()).unwrap();
        assert!(markup.starts_with("<g id=\"el-1\" data-comot-type=\"table\""));
        assert!(markup.contains("data-comot-cols=\"100\""));
        assert!(markup.contains("data-comot-theme=\"dark\""));
        assert!(!markup.contains("data-comot-header"));
    }

    #[test]
    fn header_attr_present_only_when_header_true() {
        let mut model = one_cell_model();
        model.header = true;
        let markup = render_table_markup(&model, "el-1", None, &fonts_with_default()).unwrap();
        assert!(markup.contains("data-comot-header=\"1\""));
    }

    #[test]
    fn transform_is_escaped_and_present_when_given() {
        let model = one_cell_model();
        let markup = render_table_markup(
            &model,
            "el-1",
            Some("translate(1 2)"),
            &fonts_with_default(),
        )
        .unwrap();
        assert!(markup.contains("transform=\"translate(1 2)\""));
    }

    #[test]
    fn source_markup_present_only_when_bound() {
        let mut model = one_cell_model();
        model.source = Some("assets/data/x.csv".to_string());
        let markup = render_table_markup(&model, "el-1", None, &fonts_with_default()).unwrap();
        assert!(markup.contains("<comot:source"));
        assert!(markup.contains("src=\"assets/data/x.csv\""));
    }

    #[test]
    fn cells_are_sorted_row_then_col_regardless_of_input_order() {
        let mut model = TableModel {
            cols: vec![50.0, 50.0],
            rows: vec![0.0, 0.0],
            header: false,
            theme: TableTheme::Dark,
            source: None,
            cells: vec![cell(1, 0), cell(0, 1), cell(0, 0), cell(1, 1)],
        };
        model.rows = vec![0.0, 0.0];
        let markup = render_table_markup(&model, "el-1", None, &fonts_with_default()).unwrap();
        let pos = |needle: &str| markup.find(needle).unwrap();
        assert!(pos("data-comot-cell=\"0,0\"") < pos("data-comot-cell=\"0,1\""));
        assert!(pos("data-comot-cell=\"0,1\"") < pos("data-comot-cell=\"1,0\""));
        assert!(pos("data-comot-cell=\"1,0\"") < pos("data-comot-cell=\"1,1\""));
    }

    #[test]
    fn span_attr_present_only_when_spanning() {
        let mut model = one_cell_model();
        model.cols = vec![50.0, 50.0];
        model.cells = vec![TableCell {
            col_span: 2,
            ..cell(0, 0)
        }];
        let markup = render_table_markup(&model, "el-1", None, &fonts_with_default()).unwrap();
        assert!(markup.contains("data-comot-span=\"1,2\""));
    }

    #[test]
    fn repeat_and_generated_attrs() {
        let mut model = one_cell_model();
        model.cells[0].repeat = true;
        model.cells[0].generated = true;
        let markup = render_table_markup(&model, "el-1", None, &fonts_with_default()).unwrap();
        assert!(markup.contains("data-comot-repeat=\"row\" display=\"none\""));
        assert!(markup.contains("data-comot-generated=\"1\""));
    }

    #[test]
    fn align_attr_omitted_for_left_present_otherwise() {
        let mut model = one_cell_model();
        model.cells[0].align = CellAlign::Center;
        let markup = render_table_markup(&model, "el-1", None, &fonts_with_default()).unwrap();
        assert!(markup.contains("data-comot-align=\"center\""));
    }
}
