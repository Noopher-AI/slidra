//! `co-motion element delete` argv layer.

use crate::commands::argv::{require_id_list, require_positional};
use crate::element::edit;
use crate::errors::CoMotionResult;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_positional(args, 0, "element delete", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element delete", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element delete")?;

    let slide = write::require_slide(&id, &slide_path)?;
    let updated = edit::delete_elements(&slide.content, &slide_path, &element_ids)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("已刪除 {slide_path} 的 {} 個元素", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
