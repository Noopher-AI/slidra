//! `co-motion slide add|delete|duplicate|move|notes set|style set|transition
//! set|render`.

use crate::argv;
use crate::errors::CoMotionError;
use crate::result::{CommandResult, FailureKind};
use crate::slide::ops::{self, AddSlideInput, SetSlideTransitionOnInput};
use crate::slide::style::PageStyleUpdate;
use crate::slide::transition::PageTransitionEffect;
use crate::workspace::{self, project::read_project_json, virtual_fs, write as ws_write};

pub fn run(args: &[String]) -> CommandResult {
    let sub = args.first().map(String::as_str);
    let rest: &[String] = args.get(1..).unwrap_or(&[]);

    match sub {
        Some("render") => run_render(rest),
        Some("add") => run_add(rest),
        Some("delete") => run_delete(rest),
        Some("duplicate") => run_duplicate(rest),
        Some("move") => run_move(rest),
        Some("notes") => run_notes(rest),
        Some("transition") => run_transition(rest),
        Some("style") => run_style(rest),
        other => CommandResult::failure(
            format!("未知的子命令：slide {}", other.unwrap_or("")),
            FailureKind::Failed,
        ),
    }
}

/// `slide render`'s data has the same `{ content }` shape `cat` renders —
/// reused verbatim so `main.rs` attaches the same byte-for-byte renderer.
pub fn render(data: &serde_json::Value) -> Vec<u8> {
    crate::commands::cat::render(data)
}

fn failure_kind_for(err: &CoMotionError) -> FailureKind {
    match err {
        CoMotionError::NotFound(_) => FailureKind::NotFound,
        CoMotionError::InvalidRequest(_) => FailureKind::Failed,
    }
}

fn run_render(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "slide render", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let path = match argv::require_positional(args, 1, "slide render", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match render_slide_for_display(&id, &path) {
        Ok(content) => CommandResult::success(
            format!("已渲染：{path}"),
            Some(serde_json::json!({ "content": content })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn render_slide_for_display(id: &str, slide_path: &str) -> Result<String, CoMotionError> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    let project = read_project_json(&work_dir)?;
    if !project.slides.contains(&slide_path.to_string()) {
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    }
    let original = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
    let slide_number = project
        .slides
        .iter()
        .position(|s| s == slide_path)
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut variables = std::collections::HashMap::new();
    variables.insert("slide_number".to_string(), slide_number.to_string());
    variables.insert("slide_total".to_string(), project.slides.len().to_string());
    variables.insert(
        "presentation_name".to_string(),
        crate::text::escape::escape_xml_text(&project.name),
    );
    Ok(crate::text::dynamic::substitute_dynamic_text(
        &original, &variables,
    ))
}

fn run_add(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "slide add", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let template_path = match argv::optional_flag(args, "--template") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let at = match argv::optional_flag(args, "--at") {
        Ok(Some(raw)) => match raw.parse::<f64>() {
            Ok(v) if v.is_finite() => Some(v),
            _ => {
                return CommandResult::failure(
                    format!("--at 不是合法數字：{raw}"),
                    FailureKind::Failed,
                );
            }
        },
        Ok(None) => None,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::add_slide(&id, AddSlideInput { template_path, at }) {
        Ok(result) => CommandResult::success(
            format!("已新增投影片 {}", result.slide_path),
            Some(serde_json::json!({ "slidePath": result.slide_path })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_delete(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "slide delete", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(args, 1, "slide delete", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::delete_slide(&id, &slide_path) {
        Ok(()) => CommandResult::success(
            format!("已刪除投影片 {slide_path}"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_duplicate(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "slide duplicate", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(args, 1, "slide duplicate", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::duplicate_slide(&id, &slide_path) {
        Ok(result) => CommandResult::success(
            format!("已複製投影片為 {}", result.slide_path),
            Some(serde_json::json!({ "slidePath": result.slide_path })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_move(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "slide move", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(args, 1, "slide move", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let new_index_raw = match argv::require_positional(args, 2, "slide move", "new-index") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let Ok(new_index) = new_index_raw.parse::<f64>() else {
        return CommandResult::failure(
            format!("命令 slide move 的 new-index 不是合法數字：{new_index_raw}"),
            FailureKind::Failed,
        );
    };
    if !new_index.is_finite() {
        return CommandResult::failure(
            format!("命令 slide move 的 new-index 不是合法數字：{new_index_raw}"),
            FailureKind::Failed,
        );
    }
    match ops::move_slide(&id, &slide_path, new_index) {
        Ok(()) => CommandResult::success(
            format!("已搬移投影片 {slide_path}"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_notes(args: &[String]) -> CommandResult {
    let subsub = args.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!("未知的子命令：slide notes {}", subsub.unwrap_or("")),
            FailureKind::Failed,
        );
    }
    let notes_args: &[String] = args.get(1..).unwrap_or(&[]);
    let id = match argv::require_positional(notes_args, 0, "slide notes set", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(notes_args, 1, "slide notes set", "slide-path")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    // text may legitimately be an empty string (clears the notes) — checked
    // for absence, not falsiness.
    let Some(text) = notes_args.get(2) else {
        return CommandResult::failure(
            "命令 slide notes set 缺少參數：text".to_string(),
            FailureKind::Failed,
        );
    };
    match ops::set_notes(&id, &slide_path, text) {
        Ok(()) => CommandResult::success(
            format!("已更新 {slide_path} 的備忘稿"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_transition(args: &[String]) -> CommandResult {
    let subsub = args.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!("未知的子命令：slide transition {}", subsub.unwrap_or("")),
            FailureKind::Failed,
        );
    }
    let trans_args: &[String] = args.get(1..).unwrap_or(&[]);
    let id =
        match argv::require_positional(trans_args, 0, "slide transition set", "presentation-id") {
            Ok(v) => v,
            Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
        };
    let slide_path =
        match argv::require_positional(trans_args, 1, "slide transition set", "slide-path") {
            Ok(v) => v,
            Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
        };

    let enter = match parse_effect_flag(trans_args, "--enter", "enter") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let exit = match parse_effect_flag(trans_args, "--exit", "exit") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let enter_duration = match argv::optional_number_flag(trans_args, "--enter-duration") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let exit_duration = match argv::optional_number_flag(trans_args, "--exit-duration") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let all = argv::has_flag(trans_args, "--all");

    if enter.is_none()
        && enter_duration.is_none()
        && exit.is_none()
        && exit_duration.is_none()
        && !all
    {
        return CommandResult::failure(
            "slide transition set 至少要指定一個要改的欄位".to_string(),
            FailureKind::Failed,
        );
    }

    let input = SetSlideTransitionOnInput {
        enter,
        enter_duration,
        exit,
        exit_duration,
        all,
    };
    match ops::set_slide_transition_on(&id, &slide_path, input) {
        Ok(slide_count) => {
            let message = if all {
                format!("已將頁面進出場套用到 {slide_count} 張投影片")
            } else {
                format!("已設定 {slide_path} 的頁面進出場")
            };
            CommandResult::success(message, Some(serde_json::json!({})))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn parse_effect_flag(
    args: &[String],
    flag: &str,
    label: &str,
) -> Result<Option<PageTransitionEffect>, String> {
    let Some(raw) = argv::optional_flag(args, flag)? else {
        return Ok(None);
    };
    PageTransitionEffect::parse(&raw)
        .map(Some)
        .ok_or_else(|| format!("slide transition set 不支援的 {label}：{raw}"))
}

fn run_style(args: &[String]) -> CommandResult {
    let subsub = args.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!("未知的子命令：slide style {}", subsub.unwrap_or("")),
            FailureKind::Failed,
        );
    }
    let style_args: &[String] = args.get(1..).unwrap_or(&[]);
    let id = match argv::require_positional(style_args, 0, "slide style set", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(style_args, 1, "slide style set", "slide-path")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let background = match argv::optional_flag(style_args, "--background") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let accent = match argv::optional_flag(style_args, "--accent") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    if background.is_none() && accent.is_none() {
        return CommandResult::failure(
            "命令 slide style set 至少要給 --background 或 --accent".to_string(),
            FailureKind::Failed,
        );
    }

    match set_slide_page_style(&id, &slide_path, PageStyleUpdate { background, accent }) {
        Ok(()) => CommandResult::success(
            format!("已設定 {slide_path} 的頁面樣式"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// `slide style set` — unlike `presentation canvas set`, this goes through
/// history (undo).
fn set_slide_page_style(
    id: &str,
    slide_path: &str,
    update: PageStyleUpdate,
) -> Result<(), CoMotionError> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    let project = read_project_json(&work_dir)?;
    let templates = crate::workspace::project::read_template_entries(&project);
    if !project.slides.contains(&slide_path.to_string())
        && !templates.iter().any(|t| t.file == slide_path)
    {
        return Err(CoMotionError::invalid(format!("不是投影片：{slide_path}")));
    }
    let original = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
    let updated = crate::slide::style::set_slide_page_style(&original, &update)?;
    ws_write::write_presentation_file(id, slide_path, &updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_subcommand_fails_with_trailing_space() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "未知的子命令：slide ");
    }

    #[test]
    fn unknown_notes_subcommand_fails() {
        let result = run(&["notes".to_string(), "frobnicate".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.message, "未知的子命令：slide notes frobnicate");
    }

    #[test]
    fn notes_set_missing_text_fails() {
        let result = run(&[
            "notes".to_string(),
            "set".to_string(),
            "id".to_string(),
            "slides/001.svg".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 slide notes set 缺少參數：text");
    }

    #[test]
    fn transition_set_no_fields_fails() {
        let result = run(&[
            "transition".to_string(),
            "set".to_string(),
            "id".to_string(),
            "slides/001.svg".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "slide transition set 至少要指定一個要改的欄位"
        );
    }

    #[test]
    fn transition_set_invalid_enter_fails() {
        let result = run(&[
            "transition".to_string(),
            "set".to_string(),
            "id".to_string(),
            "slides/001.svg".to_string(),
            "--enter".to_string(),
            "bogus".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(result.message, "slide transition set 不支援的 enter：bogus");
    }

    #[test]
    fn style_set_neither_flag_fails() {
        let result = run(&[
            "style".to_string(),
            "set".to_string(),
            "id".to_string(),
            "slides/001.svg".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "命令 slide style set 至少要給 --background 或 --accent"
        );
    }
}
