//! `chart *` command handlers (8 commands), mirroring
//! `packages/core/src/workspace.ts`'s `createSlideChart`/`setSlideChartData`/
//! `setSlideChartType`/`setSlideChartPalette`/`setSlideChartAxis`/
//! `setSlideChartStack`/`setSlideChartLegend`/`setSlideChartOption` (lines
//! ~1753-1909): resolve -> assert listed -> read -> pure core function ->
//! write. `chart data set`'s three data sources are resolved to a plain
//! `(categories, series)` HERE, the one layer allowed to touch the
//! filesystem — `chart::edit` itself only ever sees already-parsed data.

use crate::argv::chart::{ChartCommand, parse};
use crate::chart::csv::parse_chart_csv;
use crate::chart::edit;
use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::workspace::{self, virtual_fs};

fn failure_kind_for(err: &SlidraError) -> FailureKind {
    match err {
        SlidraError::NotFound(_) => FailureKind::NotFound,
        SlidraError::InvalidRequest(_) => FailureKind::Failed,
    }
}

fn result_of(
    outcome: Result<(String, String, serde_json::Value, String), SlidraError>,
) -> CommandResult {
    match outcome {
        Ok((_id, _slide_path, data, message)) => CommandResult::success(message, Some(data)),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// Reads `slide_path`'s current content after confirming it both exists
/// and is a declared slide/template — the check-order every write-path
/// wrapper in `workspace.ts` shares (a missing real file is reported
/// before "not a slide").
fn read_slide(id: &str, slide_path: &str) -> Result<String, SlidraError> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    workspace::write::assert_slide_path_listed(&work_dir, slide_path)?;
    virtual_fs::read_virtual_file(&work_dir, slide_path)
}

/// `stdin_csv` is `Some(text)` only when `main.rs` detected a literal
/// `--csv -` token pair for a `chart data set` invocation and pre-read all
/// of stdin as UTF-8 (`cli.md`'s stdin-substitution contract — the
/// substitution happens at the entry layer, never inside argv parsing,
/// since a future `serve` mode bypasses argv entirely).
pub fn run(args: &[String], stdin_csv: Option<String>) -> CommandResult {
    let command = match parse(args) {
        Ok(command) => command,
        Err(err) => {
            return CommandResult::failure(err.message().to_string(), failure_kind_for(&err));
        }
    };

    match command {
        ChartCommand::Create {
            id,
            slide_path,
            input,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;
            let element_id = crate::id::generate_element_id();
            let updated = edit::create_chart_element(&original, &slide_path, &element_id, &input)?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({ "elementId": element_id }),
                format!("已在 {slide_path} 新增圖表 {element_id}"),
            ))
        })()),

        ChartCommand::DataSet {
            id,
            slide_path,
            element_id,
            csv,
            csv_asset,
            categories,
            series,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;

            let (categories, series) = if let Some(csv_value) = csv {
                let text = if csv_value == "-" {
                    stdin_csv
                        .clone()
                        .ok_or_else(|| SlidraError::invalid("--csv - 只能從命令列使用"))?
                } else {
                    std::fs::read_to_string(&csv_value).map_err(|_| {
                        SlidraError::not_found(format!("找不到 CSV 檔案：{csv_value}"))
                    })?
                };
                let parsed = parse_chart_csv(&text)?;
                (
                    parsed.categories,
                    parsed
                        .series
                        .into_iter()
                        .map(|s| (s.name, s.values))
                        .collect(),
                )
            } else if let Some(csv_asset) = csv_asset {
                let work_dir = workspace::resolve_work_dir(&id)?;
                let text = virtual_fs::read_virtual_file(&work_dir, &csv_asset)?;
                let parsed = parse_chart_csv(&text)?;
                (
                    parsed.categories,
                    parsed
                        .series
                        .into_iter()
                        .map(|s| (s.name, s.values))
                        .collect(),
                )
            } else {
                (categories.unwrap_or_default(), series)
            };

            let updated = edit::set_chart_data(
                &original,
                &slide_path,
                &element_id,
                edit::SetChartDataInput { categories, series },
            )?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({}),
                format!("已更新 {slide_path} 圖表 {element_id} 的資料"),
            ))
        })()),

        ChartCommand::TypeSet {
            id,
            slide_path,
            element_id,
            chart_type,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;
            let updated = edit::set_chart_type(&original, &slide_path, &element_id, &chart_type)?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({}),
                format!("已將 {slide_path} 圖表 {element_id} 的類型改為 {chart_type}"),
            ))
        })()),

        ChartCommand::PaletteSet {
            id,
            slide_path,
            element_id,
            palette,
            colors,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;
            let updated =
                edit::set_chart_palette(&original, &slide_path, &element_id, &palette, &colors)?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({}),
                format!("已將 {slide_path} 圖表 {element_id} 的調色盤改為 {palette}"),
            ))
        })()),

        ChartCommand::AxisSet {
            id,
            slide_path,
            element_id,
            input,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;
            let updated = edit::set_chart_axis(&original, &slide_path, &element_id, input)?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({}),
                format!("已更新 {slide_path} 圖表 {element_id} 的座標軸設定"),
            ))
        })()),

        ChartCommand::StackSet {
            id,
            slide_path,
            element_id,
            stacked,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;
            let updated = edit::set_chart_stack(&original, &slide_path, &element_id, stacked)?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({}),
                format!("已更新 {slide_path} 圖表 {element_id} 的堆疊設定"),
            ))
        })()),

        ChartCommand::LegendSet {
            id,
            slide_path,
            element_id,
            legend,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;
            let updated = edit::set_chart_legend(&original, &slide_path, &element_id, &legend)?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({}),
                format!("已更新 {slide_path} 圖表 {element_id} 的圖例設定"),
            ))
        })()),

        ChartCommand::OptionSet {
            id,
            slide_path,
            element_id,
            key,
            value,
        } => result_of((|| {
            let original = read_slide(&id, &slide_path)?;
            let updated =
                edit::set_chart_option(&original, &slide_path, &element_id, &key, &value)?;
            workspace::write::write_presentation_file(&id, &slide_path, &updated)?;
            Ok((
                id.clone(),
                slide_path.clone(),
                serde_json::json!({}),
                format!("已更新 {slide_path} 圖表 {element_id} 的 {key} 設定"),
            ))
        })()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-commands-chart-{label}-{}",
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
                std::env::set_var("SLIDRA_HOME", &home);
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
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn create_then_data_set_writes_expected_markup() {
        let fixture = Fixture::new("create-data-set", "pid-chart-1");

        let create_result = run(&s(&["create", fixture.id, "slides/001.svg"]), None);
        assert!(create_result.ok, "{}", create_result.message);
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(fixture.slide().contains(&format!("id=\"{element_id}\"")));

        let data_result = run(
            &s(&[
                "data",
                "set",
                fixture.id,
                "slides/001.svg",
                &element_id,
                "--categories",
                "Q1,Q2",
                "--series",
                "Revenue=120,150",
            ]),
            None,
        );
        assert!(data_result.ok, "{}", data_result.message);
        let svg = fixture.slide();
        assert!(svg.contains(r#"<slidra:categories values="Q1,Q2"/>"#));
        assert!(svg.contains(r#"name="Revenue" values="120,150""#));
    }

    #[test]
    fn data_set_csv_dash_uses_stdin_csv_when_provided() {
        let fixture = Fixture::new("csv-stdin", "pid-chart-2");
        let create_result = run(&s(&["create", fixture.id, "slides/001.svg"]), None);
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();

        let stdin_text = "Quarter,Revenue\nQ1,120\nQ2,150\n".to_string();
        let result = run(
            &s(&[
                "data",
                "set",
                fixture.id,
                "slides/001.svg",
                &element_id,
                "--csv",
                "-",
            ]),
            Some(stdin_text),
        );
        assert!(result.ok, "{}", result.message);
        let svg = fixture.slide();
        assert!(svg.contains(r#"<slidra:categories values="Q1,Q2"/>"#));
        assert!(svg.contains(r#"name="Revenue" values="120,150""#));
    }

    #[test]
    fn data_set_csv_dash_without_stdin_csv_fails_instead_of_reading_a_file_named_dash() {
        let fixture = Fixture::new("csv-stdin-missing", "pid-chart-3");
        let create_result = run(&s(&["create", fixture.id, "slides/001.svg"]), None);
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();

        let result = run(
            &s(&[
                "data",
                "set",
                fixture.id,
                "slides/001.svg",
                &element_id,
                "--csv",
                "-",
            ]),
            None,
        );
        assert!(!result.ok);
        assert_eq!(result.message, "--csv - 只能從命令列使用");
    }

    #[test]
    fn unknown_element_id_on_data_set_is_a_failure_not_a_not_found() {
        let fixture = Fixture::new("unknown-element", "pid-chart-4");
        run(&s(&["create", fixture.id, "slides/001.svg"]), None);
        let result = run(
            &s(&[
                "data",
                "set",
                fixture.id,
                "slides/001.svg",
                "el-does-not-exist",
                "--categories",
                "A,B",
                "--series",
                "S=1,2",
            ]),
            None,
        );
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::Failed));
    }

    #[test]
    fn create_writes_exactly_one_undo_step() {
        let fixture = Fixture::new("undo-step", "pid-chart-5");
        run(&s(&["create", fixture.id, "slides/001.svg"]), None);
        let before_second_create = fixture.slide();
        run(&s(&["create", fixture.id, "slides/001.svg"]), None);

        let undo_result = crate::history::undo(fixture.id).unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(fixture.slide(), before_second_create);
    }

    /// Regression: `ScannedNode` offsets are UTF-16 code-unit offsets (see
    /// `slide/scan.rs`'s module doc), not Rust byte offsets. A slide with
    /// CJK text/attribute content BEFORE the insertion point — the common
    /// case, since every real deck's title slide has one — reproduces the
    /// exact corruption a raw `&svg_content[..content_end]` byte-slice
    /// produced during this ticket's manual verification: the markup
    /// landed a few bytes into the middle of the preceding element's own
    /// closing tag. Every other test in this crate's chart/table fixtures
    /// used ASCII-only slide content and could not have caught this.
    #[test]
    fn create_after_cjk_content_produces_well_formed_xml() {
        let fixture = Fixture::new("cjk-before-insert", "pid-chart-cjk");
        std::fs::write(
            fixture.work.join("slides/001.svg"),
            r#"<svg viewBox="0 0 1280 720">
  <g id="el-title" data-slidra-name="標題">
    <text x="640" y="360" text-anchor="middle" font-family="Noto Sans TC" font-size="48">示範簡報</text>
  </g>
</svg>"#,
        )
        .unwrap();

        let create_result = run(&s(&["create", fixture.id, "slides/001.svg"]), None);
        assert!(create_result.ok, "{}", create_result.message);
        let element_id = create_result.data.unwrap()["elementId"]
            .as_str()
            .unwrap()
            .to_string();

        let svg = fixture.slide();
        // The preceding element's closing tags must survive intact —
        // this is exactly what the UTF-16/byte-offset bug corrupted.
        assert!(svg.contains("</text>\n  </g>\n"));
        assert!(svg.contains(&format!(
            "<g id=\"{element_id}\" data-slidra-type=\"chart\""
        )));
        assert!(svg.trim_end().ends_with("</svg>"));

        // The written bytes must also round-trip through the scanner
        // without a "not a legal tag" structural error — the failure
        // mode this bug actually produced end to end.
        crate::slide::scan::scan_document(&svg)
            .expect("markup must be well-formed after insertion");

        // A subsequent edit on the same (now CJK-preceded) document must
        // also succeed, exercising the splice path (not just the initial
        // insert path).
        let data_result = run(
            &s(&[
                "data",
                "set",
                fixture.id,
                "slides/001.svg",
                &element_id,
                "--categories",
                "A,B",
                "--series",
                "S=1,2",
            ]),
            None,
        );
        assert!(data_result.ok, "{}", data_result.message);
        crate::slide::scan::scan_document(&fixture.slide())
            .expect("markup must remain well-formed after a splice-based edit");
    }
}
