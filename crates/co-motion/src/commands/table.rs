//! `table *` command handlers (17 commands), mirroring
//! `packages/core/src/workspace.ts`'s `createSlideTable`/
//! `setSlideTableCellText`/`setSlideTableCellStyle`/`mergeSlideTableCells`/
//! `setSlideTableColWidth`/`insertSlideTableColumn`/`deleteSlideTableColumn`/
//! `insertSlideTableRow`/`deleteSlideTableRow`/`setSlideTableTheme`/
//! `setSlideTableHeader`/`bindSlideTableSource`/`refreshSlideTableSource`/
//! `setSlideTable`/`copyTableCells`/`cutTableCells`/`pasteTableCells`
//! (lines ~1436-1750): resolve -> assert listed -> read -> pure core
//! function -> write. `table bind`/`table refresh`/`table set --from`'s CSV
//! source is resolved to a plain `ParsedTableCsv` HERE, the one layer
//! allowed to touch the filesystem — `table::edit`/`table::clipboard`
//! themselves only ever see already-parsed data.

use crate::argv::table::{TableCommand, parse};
use crate::errors::CoMotionError;
use crate::result::{CommandResult, FailureKind};
use crate::table::clipboard::{
    copy_table_cell_range, cut_table_cell_range, paste_table_cell_range,
};
use crate::table::csv::parse_table_csv;
use crate::table::edit;
use crate::table::markdown::parse_markdown_table;
use crate::workspace::{self, virtual_fs};

fn failure_kind_for(err: &CoMotionError) -> FailureKind {
    match err {
        CoMotionError::NotFound(_) => FailureKind::NotFound,
        CoMotionError::InvalidRequest(_) => FailureKind::Failed,
    }
}

fn ok(message: impl Into<String>, data: serde_json::Value) -> CommandResult {
    CommandResult::success(message, Some(data))
}

fn err_result(err: CoMotionError) -> CommandResult {
    CommandResult::failure(err.message().to_string(), failure_kind_for(&err))
}

/// Reads `slide_path`'s current content after confirming it both exists
/// and is a declared slide/template.
fn read_slide(id: &str, slide_path: &str) -> Result<String, CoMotionError> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    workspace::write::assert_slide_path_listed(&work_dir, slide_path)?;
    virtual_fs::read_virtual_file(&work_dir, slide_path)
}

pub fn run(args: &[String]) -> CommandResult {
    let command = match parse(args) {
        Ok(command) => command,
        Err(err) => return err_result(err),
    };

    macro_rules! try_or_return {
        ($expr:expr) => {
            match $expr {
                Ok(value) => value,
                Err(err) => return err_result(err),
            }
        };
    }

    match command {
        TableCommand::Create {
            id,
            slide_path,
            input,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let element_id = crate::id::generate_element_id();
            let updated = try_or_return!(edit::create_table_element(
                &original,
                &slide_path,
                &element_id,
                &input,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已在 {slide_path} 新增表格 {element_id}"),
                serde_json::json!({ "elementId": element_id }),
            )
        }

        TableCommand::CellSet {
            id,
            slide_path,
            element_id,
            row,
            col,
            text,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::set_table_cell_text(
                &original,
                &slide_path,
                &element_id,
                row,
                col,
                &text,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已更新 {slide_path} 表格 {element_id} 的儲存格"),
                serde_json::json!({}),
            )
        }

        TableCommand::CellStyleSet {
            id,
            slide_path,
            element_id,
            input,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::set_table_cell_style(
                &original,
                &slide_path,
                &element_id,
                input,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已更新 {slide_path} 表格 {element_id} 的儲存格樣式"),
                serde_json::json!({}),
            )
        }

        TableCommand::Merge {
            id,
            slide_path,
            element_id,
            input,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let unmerge = input.unmerge;
            let updated = try_or_return!(edit::merge_table_cells(
                &original,
                &slide_path,
                &element_id,
                input,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            let verb = if unmerge { "取消合併" } else { "合併" };
            ok(
                format!("已{verb} {slide_path} 表格 {element_id} 的儲存格"),
                serde_json::json!({}),
            )
        }

        TableCommand::ColWidth {
            id,
            slide_path,
            element_id,
            col,
            width,
            keep_total,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::set_table_col_width(
                &original,
                &slide_path,
                &element_id,
                col,
                width,
                &fonts,
                keep_total
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已更新 {slide_path} 表格 {element_id} 的欄寬"),
                serde_json::json!({}),
            )
        }

        TableCommand::ColInsert {
            id,
            slide_path,
            element_id,
            at,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::insert_table_column(
                &original,
                &slide_path,
                &element_id,
                at,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已在 {slide_path} 表格 {element_id} 插入一欄"),
                serde_json::json!({}),
            )
        }

        TableCommand::ColDelete {
            id,
            slide_path,
            element_id,
            at,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::delete_table_column(
                &original,
                &slide_path,
                &element_id,
                at,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已刪除 {slide_path} 表格 {element_id} 的一欄"),
                serde_json::json!({}),
            )
        }

        TableCommand::RowInsert {
            id,
            slide_path,
            element_id,
            at,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::insert_table_row(
                &original,
                &slide_path,
                &element_id,
                at,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已在 {slide_path} 表格 {element_id} 插入一列"),
                serde_json::json!({}),
            )
        }

        TableCommand::RowDelete {
            id,
            slide_path,
            element_id,
            at,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::delete_table_row(
                &original,
                &slide_path,
                &element_id,
                at,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已刪除 {slide_path} 表格 {element_id} 的一列"),
                serde_json::json!({}),
            )
        }

        TableCommand::ThemeSet {
            id,
            slide_path,
            element_id,
            theme,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::set_table_theme(
                &original,
                &slide_path,
                &element_id,
                &theme,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已將 {slide_path} 表格 {element_id} 的主題改為 {theme}"),
                serde_json::json!({}),
            )
        }

        TableCommand::HeaderSet {
            id,
            slide_path,
            element_id,
            header,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::set_table_header(
                &original,
                &slide_path,
                &element_id,
                header,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已更新 {slide_path} 表格 {element_id} 的表頭設定"),
                serde_json::json!({}),
            )
        }

        TableCommand::Bind {
            id,
            slide_path,
            element_id,
            source,
            template_row,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let work_dir = try_or_return!(workspace::resolve_work_dir(&id));
            let csv_text = try_or_return!(virtual_fs::read_virtual_file(&work_dir, &source));
            let csv = try_or_return!(parse_table_csv(&csv_text));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::bind_table_source(
                &original,
                &slide_path,
                &element_id,
                &source,
                template_row,
                &csv,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已將 {slide_path} 表格 {element_id} 綁定到 {source}"),
                serde_json::json!({}),
            )
        }

        TableCommand::Refresh {
            id,
            slide_path,
            element_id,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let current_model = try_or_return!(crate::table::model::read_table_model(
                &original,
                &element_id
            ));
            let source = match current_model.source {
                Some(source) => source,
                None => {
                    return err_result(CoMotionError::invalid(format!(
                        "表格 {element_id} 沒有資料來源"
                    )));
                }
            };
            let work_dir = try_or_return!(workspace::resolve_work_dir(&id));
            let csv_text = try_or_return!(virtual_fs::read_virtual_file(&work_dir, &source));
            let csv = try_or_return!(parse_table_csv(&csv_text));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let updated = try_or_return!(edit::refresh_table_source(
                &original,
                &slide_path,
                &element_id,
                &csv,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已重新整理 {slide_path} 表格 {element_id} 的資料"),
                serde_json::json!({}),
            )
        }

        TableCommand::Set {
            id,
            slide_path,
            element_id,
            from,
            markdown,
            markdown_file,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));

            if let Some(from) = from {
                let work_dir = try_or_return!(workspace::resolve_work_dir(&id));
                let csv_text = try_or_return!(virtual_fs::read_virtual_file(&work_dir, &from));
                let csv = try_or_return!(parse_table_csv(&csv_text));
                let updated = try_or_return!(edit::set_table_from_csv(
                    &original,
                    &slide_path,
                    &element_id,
                    &csv,
                    &fonts
                ));
                try_or_return!(workspace::write::write_presentation_file(
                    &id,
                    &slide_path,
                    &updated
                ));
                return ok(
                    format!("已將 {slide_path} 表格 {element_id} 的內容改為 {from} 的資料"),
                    serde_json::json!({}),
                );
            }

            let markdown_text = if let Some(markdown_file) = markdown_file {
                match std::fs::read_to_string(&markdown_file) {
                    Ok(text) => text,
                    Err(_) => {
                        return err_result(CoMotionError::not_found(format!(
                            "找不到 Markdown 檔案：{markdown_file}"
                        )));
                    }
                }
            } else {
                markdown.expect("argv layer already guaranteed exactly one source is given")
            };
            let parsed = try_or_return!(parse_markdown_table(&markdown_text));
            let updated = try_or_return!(edit::set_table_from_markdown(
                &original,
                &slide_path,
                &element_id,
                &parsed,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &updated
            ));
            ok(
                format!("已將 {slide_path} 表格 {element_id} 的內容改為 Markdown 表格"),
                serde_json::json!({}),
            )
        }

        TableCommand::CellCopy {
            id,
            slide_path,
            element_id,
            range,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let tsv = try_or_return!(copy_table_cell_range(
                &original,
                &slide_path,
                &element_id,
                &range
            ));
            ok(
                format!("已複製 {element_id} 的儲存格範圍"),
                serde_json::json!({ "tsv": tsv }),
            )
        }

        TableCommand::CellCut {
            id,
            slide_path,
            element_id,
            range,
        } => {
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let result = try_or_return!(cut_table_cell_range(
                &original,
                &slide_path,
                &element_id,
                &range,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &result.updated
            ));
            ok(
                format!("已剪下 {element_id} 的儲存格範圍"),
                serde_json::json!({ "tsv": result.tsv }),
            )
        }

        TableCommand::CellPaste {
            id,
            slide_path,
            element_id,
            anchor,
            tsv_file,
        } => {
            let tsv = match std::fs::read_to_string(&tsv_file) {
                Ok(text) => text,
                Err(_) => {
                    return err_result(CoMotionError::not_found(format!(
                        "找不到來源檔案：{tsv_file}"
                    )));
                }
            };
            let original = try_or_return!(read_slide(&id, &slide_path));
            let fonts = try_or_return!(workspace::fonts::resolve_presentation_fonts(&id));
            let result = try_or_return!(paste_table_cell_range(
                &original,
                &slide_path,
                &element_id,
                &anchor,
                &tsv,
                &fonts
            ));
            try_or_return!(workspace::write::write_presentation_file(
                &id,
                &slide_path,
                &result.updated
            ));
            ok(
                format!("已貼上 {} 個儲存格到 {element_id}", result.cells),
                serde_json::json!({ "cells": result.cells }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-commands-table-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn register(home: &Path, test_id: &str, work_dir: &Path) {
        let work_dir_json =
            serde_json::to_string(&work_dir.to_string_lossy().into_owned()).unwrap();
        let id_json = serde_json::to_string(test_id).unwrap();
        let json = format!(r#"{{{id_json}:{{"workDir":{work_dir_json}}}}}"#);
        std::fs::write(home.join("projects.json"), json).unwrap();
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        id: &'static str,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, id: &'static str) -> Self {
            let guard = crate::workspace::registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            register(&home, id, &work);
            std::fs::write(
                work.join("project.json"),
                r#"{"formatVersion":1,"name":"T","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"]}"#,
            )
            .unwrap();
            std::fs::create_dir_all(work.join("slides")).unwrap();
            std::fs::write(
                work.join("slides/001.svg"),
                r#"<svg viewBox="0 0 1280 720"></svg>"#,
            )
            .unwrap();
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }
            Fixture {
                home,
                work,
                id,
                _guard: guard,
            }
        }

        fn slide(&self) -> String {
            std::fs::read_to_string(self.work.join("slides/001.svg")).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn create_then_cell_set_writes_expected_markup() {
        let fixture = Fixture::new("create-cell-set", "pid-table-1");
        let create_result = run(&s(&[
            "create",
            fixture.id,
            "slides/001.svg",
            "--rows",
            "2",
            "--cols",
            "2",
            "--x",
            "0",
            "--y",
            "0",
        ]));
        assert!(create_result.ok, "{}", create_result.message);
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(fixture.slide().contains(&format!("id=\"{element_id}\"")));

        let set_result = run(&s(&[
            "cell",
            "set",
            fixture.id,
            "slides/001.svg",
            &element_id,
            "--row",
            "0",
            "--col",
            "0",
            "--text",
            "hi",
        ]));
        assert!(set_result.ok, "{}", set_result.message);
        assert!(fixture.slide().contains("hi"));
    }

    #[test]
    fn cell_copy_is_read_only_and_does_not_occupy_an_undo_step() {
        let fixture = Fixture::new("cell-copy-readonly", "pid-table-2");
        let create_result = run(&s(&[
            "create",
            fixture.id,
            "slides/001.svg",
            "--rows",
            "1",
            "--cols",
            "1",
            "--x",
            "0",
            "--y",
            "0",
        ]));
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();

        let copy_result = run(&s(&[
            "cell",
            "copy",
            fixture.id,
            "slides/001.svg",
            &element_id,
            "--range",
            "0,0:0,0",
        ]));
        assert!(copy_result.ok, "{}", copy_result.message);

        // Undo should revert the CREATE (the only real write so far), not
        // some phantom copy step.
        let undo_result = crate::history::undo(fixture.id).unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert!(!fixture.slide().contains(&element_id));
    }

    #[test]
    fn col_delete_on_last_column_fails() {
        let fixture = Fixture::new("col-delete-last", "pid-table-3");
        let create_result = run(&s(&[
            "create",
            fixture.id,
            "slides/001.svg",
            "--rows",
            "1",
            "--cols",
            "1",
            "--x",
            "0",
            "--y",
            "0",
        ]));
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();

        let result = run(&s(&[
            "col",
            "delete",
            fixture.id,
            "slides/001.svg",
            &element_id,
            "--at",
            "0",
        ]));
        assert!(!result.ok);
        assert_eq!(result.message, "表格至少要有一欄");
    }

    #[test]
    fn set_from_markdown_file_not_found_is_not_found() {
        let fixture = Fixture::new("markdown-file-missing", "pid-table-4");
        let create_result = run(&s(&[
            "create",
            fixture.id,
            "slides/001.svg",
            "--rows",
            "1",
            "--cols",
            "1",
            "--x",
            "0",
            "--y",
            "0",
        ]));
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();

        let result = run(&s(&[
            "set",
            fixture.id,
            "slides/001.svg",
            &element_id,
            "--markdown-file",
            "/definitely/does/not/exist.md",
        ]));
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }

    /// Regression: same UTF-16/byte-offset hazard as
    /// `commands::chart`'s identical test — see that test's doc comment.
    /// Table's write path has its own direct-slice call sites
    /// (`table::edit::update_table`/`create_table_element`), independent
    /// of chart's, so this needs its own regression coverage.
    #[test]
    fn create_and_cell_set_after_cjk_content_produces_well_formed_xml() {
        let fixture = Fixture::new("cjk-before-insert", "pid-table-cjk");
        std::fs::write(
            fixture.work.join("slides/001.svg"),
            r#"<svg viewBox="0 0 1280 720">
  <g id="el-title" data-comot-name="標題">
    <text x="640" y="360" text-anchor="middle" font-family="Noto Sans TC" font-size="48">示範簡報</text>
  </g>
</svg>"#,
        )
        .unwrap();

        let create_result = run(&s(&[
            "create",
            fixture.id,
            "slides/001.svg",
            "--rows",
            "1",
            "--cols",
            "1",
            "--x",
            "0",
            "--y",
            "0",
        ]));
        assert!(create_result.ok, "{}", create_result.message);
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();

        let svg = fixture.slide();
        assert!(svg.contains("</text>\n  </g>\n"));
        crate::slide::scan::scan_document(&svg)
            .expect("markup must be well-formed after insertion");

        let set_result = run(&s(&[
            "cell",
            "set",
            fixture.id,
            "slides/001.svg",
            &element_id,
            "--row",
            "0",
            "--col",
            "0",
            "--text",
            "你好",
        ]));
        assert!(set_result.ok, "{}", set_result.message);
        let svg_after_edit = fixture.slide();
        assert!(svg_after_edit.contains("你好"));
        crate::slide::scan::scan_document(&svg_after_edit)
            .expect("markup must remain well-formed after a splice-based edit");
    }
}
