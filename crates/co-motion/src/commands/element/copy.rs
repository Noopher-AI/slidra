//! `co-motion element copy` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::clipboard;
use crate::errors::{CoMotionError, CoMotionResult};
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_id_positional(args, 0, "element copy", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element copy", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element copy")?;

    let slide = write::require_slide(&id, &slide_path)?;
    let payload = clipboard::extract_elements_for_copy(&slide.content, &slide_path, &element_ids)?;
    let contents = serde_json::to_string(&payload)
        .map_err(|_| CoMotionError::invalid("無法序列化剪貼簿內容"))?;
    write::write_clipboard_file(&id, &contents)?;
    let svg = clipboard::serialize_clipboard_svg(&payload)?;

    Ok(CommandResult::success(
        format!("已複製 {slide_path} 的 {} 個元素", element_ids.len()),
        Some(serde_json::json!({ "svg": svg })),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
