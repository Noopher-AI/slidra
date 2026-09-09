//! `co-motion element cut` argv layer.

use crate::commands::argv::{require_id_list, require_positional};
use crate::element::clipboard;
use crate::element::edit;
use crate::errors::{CoMotionError, CoMotionResult};
use crate::result::CommandResult;
use crate::workspace::write;

/// Extraction runs before deletion (it reads the pre-deletion content, and
/// any missing id fails the whole command before anything is mutated), and
/// the clipboard write happens before `write_presentation_file` (a failed
/// clipboard write must never leave the presentation already edited) —
/// mirrors `workspace.ts`'s `cutSlideElements` ordering exactly.
fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_positional(args, 0, "element cut", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element cut", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element cut")?;

    let slide = write::require_slide(&id, &slide_path)?;
    let payload = clipboard::extract_elements_for_copy(&slide.content, &slide_path, &element_ids)?;
    let updated = edit::delete_elements(&slide.content, &slide_path, &element_ids)?;
    let contents = serde_json::to_string(&payload)
        .map_err(|_| CoMotionError::invalid("無法序列化剪貼簿內容"))?;
    write::write_clipboard_file(&id, &contents)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;
    let svg = clipboard::serialize_clipboard_svg(&payload)?;

    Ok(CommandResult::success(
        format!("已剪下 {slide_path} 的 {} 個元素", element_ids.len()),
        Some(serde_json::json!({ "svg": svg })),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
