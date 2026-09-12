//! `slidra element move` argv layer. Named `move_cmd` (not `move`) —
//! `move` is a Rust keyword and cannot be a module identifier.

use crate::commands::argv::{
    has_flag, require_id_list, require_id_positional, require_number_flag, require_positional,
};
use crate::element::edit;
use crate::errors::SlidraResult;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element move", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element move", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element move")?;
    let dx = require_number_flag(args, "--dx", "element move")?;
    let dy = require_number_flag(args, "--dy", "element move")?;
    let force = has_flag(args, "--force");

    let slide = write::require_slide(&id, &slide_path)?;
    let updated = edit::move_elements(&slide.content, &slide_path, &element_ids, dx, dy, force)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("moved {} elements in {slide_path}", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
