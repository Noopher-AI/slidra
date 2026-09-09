//! `co-motion element scale` argv layer.

use crate::commands::argv::{has_flag, require_id_list, require_number_flag, require_positional};
use crate::element::edit;
use crate::errors::CoMotionResult;
use crate::fonts;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_positional(args, 0, "element scale", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element scale", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element scale")?;
    let factor = require_number_flag(args, "--factor", "element scale")?;
    let force = has_flag(args, "--force");

    let slide = write::require_slide(&id, &slide_path)?;
    let fonts = fonts::resolve_presentation_fonts(&id)?;
    let updated = edit::scale_elements(
        &slide.content,
        &slide_path,
        &element_ids,
        factor,
        &fonts,
        force,
    )?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("已縮放 {slide_path} 的 {} 個元素", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
