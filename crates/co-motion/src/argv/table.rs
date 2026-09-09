//! `table` family argv parsing, ported from `packages/cli/src/argv.ts`'s
//! `case "table":` block (lines 465-663) — flag names, positional order,
//! the `level1`/`level2`/`level3` sub-verb dispatch shape for multi-word
//! commands (`table cell style set`), and every error message are ported
//! verbatim from that range.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::table::clipboard::{CellAnchor, CellRange, parse_cell_anchor, parse_cell_range};
use crate::table::edit::{CreateTableInput, MergeTableCellsInput, SetCellStyleInput};

use super::ct::{
    has_flag, is_flag_like, optional_flag, optional_number_flag, require_flag, require_number_flag,
    require_positional,
};

#[derive(Debug)]
pub enum TableCommand {
    Create {
        id: String,
        slide_path: String,
        input: CreateTableInput,
    },
    Refresh {
        id: String,
        slide_path: String,
        element_id: String,
    },
    Bind {
        id: String,
        slide_path: String,
        element_id: String,
        source: String,
        template_row: Option<f64>,
    },
    Set {
        id: String,
        slide_path: String,
        element_id: String,
        from: Option<String>,
        markdown: Option<String>,
        markdown_file: Option<String>,
    },
    Merge {
        id: String,
        slide_path: String,
        element_id: String,
        input: MergeTableCellsInput,
    },
    CellCopy {
        id: String,
        slide_path: String,
        element_id: String,
        range: CellRange,
    },
    CellCut {
        id: String,
        slide_path: String,
        element_id: String,
        range: CellRange,
    },
    CellPaste {
        id: String,
        slide_path: String,
        element_id: String,
        anchor: CellAnchor,
        tsv_file: String,
    },
    CellSet {
        id: String,
        slide_path: String,
        element_id: String,
        row: f64,
        col: f64,
        text: String,
    },
    CellStyleSet {
        id: String,
        slide_path: String,
        element_id: String,
        input: SetCellStyleInput,
    },
    ColWidth {
        id: String,
        slide_path: String,
        element_id: String,
        col: f64,
        width: f64,
        keep_total: bool,
    },
    ColInsert {
        id: String,
        slide_path: String,
        element_id: String,
        at: f64,
    },
    ColDelete {
        id: String,
        slide_path: String,
        element_id: String,
        at: f64,
    },
    RowInsert {
        id: String,
        slide_path: String,
        element_id: String,
        at: f64,
    },
    RowDelete {
        id: String,
        slide_path: String,
        element_id: String,
        at: f64,
    },
    ThemeSet {
        id: String,
        slide_path: String,
        element_id: String,
        theme: String,
    },
    HeaderSet {
        id: String,
        slide_path: String,
        element_id: String,
        header: bool,
    },
}

pub fn parse(rest: &[String]) -> CoMotionResult<TableCommand> {
    let level1 = rest.first().map(String::as_str);

    if level1 == Some("create") {
        let args = &rest[1..];
        let id = require_positional(args, 0, "table create", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table create", "slide-path")?;
        let rows = require_number_flag(args, "--rows", "table create")?;
        let cols = require_number_flag(args, "--cols", "table create")?;
        let x = require_number_flag(args, "--x", "table create")?;
        let y = require_number_flag(args, "--y", "table create")?;
        let col_width = optional_number_flag(args, "--col-width", "table create")?;
        let theme = optional_flag(args, "--theme")?;
        let header_raw = optional_flag(args, "--header")?;
        let header = match header_raw {
            None => None,
            Some(raw) if raw == "true" => Some(true),
            Some(raw) if raw == "false" => Some(false),
            Some(raw) => {
                return Err(CoMotionError::invalid(format!(
                    "--header 只能是 true 或 false：{raw}"
                )));
            }
        };
        return Ok(TableCommand::Create {
            id,
            slide_path,
            input: CreateTableInput {
                rows,
                cols,
                x,
                y,
                col_width,
                theme,
                header,
            },
        });
    }

    if level1 == Some("refresh") {
        let args = &rest[1..];
        let id = require_positional(args, 0, "table refresh", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table refresh", "slide-path")?;
        let element_id = require_positional(args, 2, "table refresh", "element-id")?;
        return Ok(TableCommand::Refresh {
            id,
            slide_path,
            element_id,
        });
    }

    if level1 == Some("bind") {
        let args = &rest[1..];
        let id = require_positional(args, 0, "table bind", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table bind", "slide-path")?;
        let element_id = require_positional(args, 2, "table bind", "element-id")?;
        let source = require_flag(args, "--source", "table bind")?;
        let template_row = optional_number_flag(args, "--template-row", "table bind")?;
        return Ok(TableCommand::Bind {
            id,
            slide_path,
            element_id,
            source,
            template_row,
        });
    }

    if level1 == Some("set") {
        let args = &rest[1..];
        let id = require_positional(args, 0, "table set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table set", "slide-path")?;
        let element_id = require_positional(args, 2, "table set", "element-id")?;
        let from = optional_flag(args, "--from")?;
        let markdown = optional_flag(args, "--markdown")?;
        let markdown_file = optional_flag(args, "--markdown-file")?;
        let given = from.is_some() as u8 + markdown.is_some() as u8 + markdown_file.is_some() as u8;
        if given != 1 {
            return Err(CoMotionError::invalid(
                "table set 必須恰好提供一種資料來源：--from、--markdown 或 --markdown-file",
            ));
        }
        return Ok(TableCommand::Set {
            id,
            slide_path,
            element_id,
            from,
            markdown,
            markdown_file,
        });
    }

    if level1 == Some("merge") {
        let args = &rest[1..];
        let id = require_positional(args, 0, "table merge", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table merge", "slide-path")?;
        let element_id = require_positional(args, 2, "table merge", "element-id")?;
        let row = require_number_flag(args, "--row", "table merge")?;
        let col = require_number_flag(args, "--col", "table merge")?;
        let unmerge = has_flag(args, "--unmerge");
        let row_span = optional_number_flag(args, "--row-span", "table merge")?;
        let col_span = optional_number_flag(args, "--col-span", "table merge")?;
        // `row`/`col` are passed through as raw numbers, not validated or
        // truncated here — TS's argv.ts does not check them either; a
        // fractional/negative value simply matches no cell downstream in
        // merge_table_cells (see that function's own doc comment).
        return Ok(TableCommand::Merge {
            id,
            slide_path,
            element_id,
            input: MergeTableCellsInput {
                row,
                col,
                row_span,
                col_span,
                unmerge,
            },
        });
    }

    let level2 = rest.get(1).map(String::as_str);
    let level3 = rest.get(2).map(String::as_str);

    if level1 == Some("cell") && level2 == Some("copy") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table cell copy", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table cell copy", "slide-path")?;
        let element_id = require_positional(args, 2, "table cell copy", "element-id")?;
        let range = parse_cell_range(&require_flag(args, "--range", "table cell copy")?)?;
        return Ok(TableCommand::CellCopy {
            id,
            slide_path,
            element_id,
            range,
        });
    }

    if level1 == Some("cell") && level2 == Some("cut") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table cell cut", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table cell cut", "slide-path")?;
        let element_id = require_positional(args, 2, "table cell cut", "element-id")?;
        let range = parse_cell_range(&require_flag(args, "--range", "table cell cut")?)?;
        return Ok(TableCommand::CellCut {
            id,
            slide_path,
            element_id,
            range,
        });
    }

    if level1 == Some("cell") && level2 == Some("paste") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table cell paste", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table cell paste", "slide-path")?;
        let element_id = require_positional(args, 2, "table cell paste", "element-id")?;
        let anchor = parse_cell_anchor(&require_flag(args, "--at", "table cell paste")?)?;
        let tsv_file = require_flag(args, "--tsv-file", "table cell paste")?;
        return Ok(TableCommand::CellPaste {
            id,
            slide_path,
            element_id,
            anchor,
            tsv_file,
        });
    }

    if level1 == Some("cell") && level2 == Some("set") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table cell set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table cell set", "slide-path")?;
        let element_id = require_positional(args, 2, "table cell set", "element-id")?;
        let row = require_number_flag(args, "--row", "table cell set")?;
        let col = require_number_flag(args, "--col", "table cell set")?;
        let text = require_flag(args, "--text", "table cell set")?;
        return Ok(TableCommand::CellSet {
            id,
            slide_path,
            element_id,
            row,
            col,
            text,
        });
    }

    if level1 == Some("cell") && level2 == Some("style") && level3 == Some("set") {
        let args = &rest[3..];
        let id = require_positional(args, 0, "table cell style set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table cell style set", "slide-path")?;
        let element_id = require_positional(args, 2, "table cell style set", "element-id")?;
        let row = require_number_flag(args, "--row", "table cell style set")?;
        let col = require_number_flag(args, "--col", "table cell style set")?;
        let row_end = optional_number_flag(args, "--row-end", "table cell style set")?;
        let col_end = optional_number_flag(args, "--col-end", "table cell style set")?;
        let value = args.last();
        let attr = if args.len() >= 2 {
            Some(&args[args.len() - 2])
        } else {
            None
        };
        let (attr, value) = match (attr, value) {
            (Some(attr), Some(value)) if !is_flag_like(attr) && !is_flag_like(value) => {
                (attr.clone(), value.clone())
            }
            _ => {
                return Err(CoMotionError::invalid(
                    "命令 table cell style set 缺少參數：attr/value",
                ));
            }
        };
        // `row`/`col`/`row_end`/`col_end` pass through as raw numbers, not
        // validated or truncated here — TS's argv.ts does not check them
        // either; a fractional/out-of-range bound simply matches no cell
        // downstream (see `SetCellStyleInput`'s own doc comment).
        return Ok(TableCommand::CellStyleSet {
            id,
            slide_path,
            element_id,
            input: SetCellStyleInput {
                row,
                col,
                row_end,
                col_end,
                attr,
                value,
            },
        });
    }

    if level1 == Some("col") && level2 == Some("width") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table col width", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table col width", "slide-path")?;
        let element_id = require_positional(args, 2, "table col width", "element-id")?;
        let col = require_number_flag(args, "--col", "table col width")?;
        let width = require_number_flag(args, "--width", "table col width")?;
        let keep_total = has_flag(args, "--keep-total");
        return Ok(TableCommand::ColWidth {
            id,
            slide_path,
            element_id,
            col,
            width,
            keep_total,
        });
    }

    if level1 == Some("col") && level2 == Some("insert") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table col insert", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table col insert", "slide-path")?;
        let element_id = require_positional(args, 2, "table col insert", "element-id")?;
        let at = require_number_flag(args, "--at", "table col insert")?;
        return Ok(TableCommand::ColInsert {
            id,
            slide_path,
            element_id,
            at,
        });
    }

    if level1 == Some("col") && level2 == Some("delete") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table col delete", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table col delete", "slide-path")?;
        let element_id = require_positional(args, 2, "table col delete", "element-id")?;
        let at = require_number_flag(args, "--at", "table col delete")?;
        return Ok(TableCommand::ColDelete {
            id,
            slide_path,
            element_id,
            at,
        });
    }

    if level1 == Some("row") && level2 == Some("insert") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table row insert", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table row insert", "slide-path")?;
        let element_id = require_positional(args, 2, "table row insert", "element-id")?;
        let at = require_number_flag(args, "--at", "table row insert")?;
        return Ok(TableCommand::RowInsert {
            id,
            slide_path,
            element_id,
            at,
        });
    }

    if level1 == Some("row") && level2 == Some("delete") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table row delete", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table row delete", "slide-path")?;
        let element_id = require_positional(args, 2, "table row delete", "element-id")?;
        let at = require_number_flag(args, "--at", "table row delete")?;
        return Ok(TableCommand::RowDelete {
            id,
            slide_path,
            element_id,
            at,
        });
    }

    if level1 == Some("theme") && level2 == Some("set") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table theme set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table theme set", "slide-path")?;
        let element_id = require_positional(args, 2, "table theme set", "element-id")?;
        let theme = require_positional(args, 3, "table theme set", "theme")?;
        return Ok(TableCommand::ThemeSet {
            id,
            slide_path,
            element_id,
            theme,
        });
    }

    if level1 == Some("header") && level2 == Some("set") {
        let args = &rest[2..];
        let id = require_positional(args, 0, "table header set", "presentation-id")?;
        let slide_path = require_positional(args, 1, "table header set", "slide-path")?;
        let element_id = require_positional(args, 2, "table header set", "element-id")?;
        let value = require_positional(args, 3, "table header set", "true|false")?;
        let header = match value.as_str() {
            "true" => true,
            "false" => false,
            _ => {
                return Err(CoMotionError::invalid(format!(
                    "table header set 不支援的值：{value}"
                )));
            }
        };
        return Ok(TableCommand::HeaderSet {
            id,
            slide_path,
            element_id,
            header,
        });
    }

    let unknown = rest.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
    Err(CoMotionError::invalid(format!(
        "未知的子命令：table {unknown}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn create_parses_required_and_optional_flags() {
        let cmd = parse(&s(&[
            "create",
            "pres-1",
            "slides/001.svg",
            "--rows",
            "2",
            "--cols",
            "3",
            "--x",
            "10",
            "--y",
            "20",
        ]))
        .unwrap();
        match cmd {
            TableCommand::Create { input, .. } => {
                assert_eq!(input.rows, 2.0);
                assert_eq!(input.cols, 3.0);
                assert_eq!(input.header, None);
            }
            _ => panic!("expected Create"),
        }
    }

    #[test]
    fn create_header_must_be_true_or_false() {
        let err = parse(&s(&[
            "create",
            "pres-1",
            "slides/001.svg",
            "--rows",
            "1",
            "--cols",
            "1",
            "--x",
            "0",
            "--y",
            "0",
            "--header",
            "maybe",
        ]))
        .unwrap_err();
        assert_eq!(err.message(), "--header 只能是 true 或 false：maybe");
    }

    #[test]
    fn set_requires_exactly_one_source() {
        let err = parse(&s(&["set", "pres-1", "slides/001.svg", "el-a"])).unwrap_err();
        assert_eq!(
            err.message(),
            "table set 必須恰好提供一種資料來源：--from、--markdown 或 --markdown-file"
        );
    }

    #[test]
    fn cell_style_set_reads_trailing_attr_value_positionally() {
        let cmd = parse(&s(&[
            "cell",
            "style",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "--row",
            "0",
            "--col",
            "0",
            "fill",
            "#ffffff",
        ]))
        .unwrap();
        match cmd {
            TableCommand::CellStyleSet { input, .. } => {
                assert_eq!(input.attr, "fill");
                assert_eq!(input.value, "#ffffff");
            }
            _ => panic!("expected CellStyleSet"),
        }
    }

    #[test]
    fn cell_style_set_missing_attr_value_errors() {
        let err = parse(&s(&[
            "cell",
            "style",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "--row",
            "0",
            "--col",
            "0",
        ]))
        .unwrap_err();
        assert_eq!(
            err.message(),
            "命令 table cell style set 缺少參數：attr/value"
        );
    }

    #[test]
    fn cell_copy_parses_range_flag() {
        let cmd = parse(&s(&[
            "cell",
            "copy",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "--range",
            "0,0:1,1",
        ]))
        .unwrap();
        match cmd {
            TableCommand::CellCopy { range, .. } => {
                assert_eq!(
                    range,
                    CellRange {
                        top: 0,
                        left: 0,
                        bottom: 1,
                        right: 1
                    }
                );
            }
            _ => panic!("expected CellCopy"),
        }
    }

    #[test]
    fn col_width_parses_keep_total_flag() {
        let cmd = parse(&s(&[
            "col",
            "width",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "--col",
            "0",
            "--width",
            "100",
            "--keep-total",
        ]))
        .unwrap();
        match cmd {
            TableCommand::ColWidth { keep_total, .. } => assert!(keep_total),
            _ => panic!("expected ColWidth"),
        }
    }

    #[test]
    fn header_set_reads_true_false_positional() {
        let cmd = parse(&s(&[
            "header",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "true",
        ]))
        .unwrap();
        match cmd {
            TableCommand::HeaderSet { header, .. } => assert!(header),
            _ => panic!("expected HeaderSet"),
        }
        let err = parse(&s(&[
            "header",
            "set",
            "pres-1",
            "slides/001.svg",
            "el-a",
            "yes",
        ]))
        .unwrap_err();
        assert_eq!(err.message(), "table header set 不支援的值：yes");
    }

    #[test]
    fn unknown_subcommand_reports_the_first_two_tokens() {
        let err = parse(&s(&["frob", "extra"])).unwrap_err();
        assert_eq!(err.message(), "未知的子命令：table frob extra");
    }
}
