//! `slidra element rotate` argv layer.

use crate::commands::argv::{
    has_flag, require_id_list, require_id_positional, require_number_flag, require_positional,
};
use crate::element::edit;
use crate::errors::SlidraResult;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element rotate", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element rotate", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element rotate")?;
    let degrees = require_number_flag(args, "--degrees", "element rotate")?;
    let force = has_flag(args, "--force");

    let slide = write::require_slide(&id, &slide_path)?;
    let updated = edit::rotate_elements(&slide.content, &slide_path, &element_ids, degrees, force)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("已旋轉 {slide_path} 的 {} 個元素", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
