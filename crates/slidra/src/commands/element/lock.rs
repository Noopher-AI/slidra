//! `slidra element lock` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::edit;
use crate::errors::SlidraResult;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element lock", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element lock", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element lock")?;

    let slide = write::require_slide(&id, &slide_path)?;
    let updated = edit::lock_elements(&slide.content, &slide_path, &element_ids)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("locked {} elements in {slide_path}", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
