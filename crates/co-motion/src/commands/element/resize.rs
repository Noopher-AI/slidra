//! `co-motion element resize` argv layer.

use crate::commands::argv::{
    has_flag, optional_flag, require_id_list, require_number_flag, require_positional,
};
use crate::element::edit::{self, ResizeAnchor};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::fonts;
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_anchor(raw: &str) -> CoMotionResult<ResizeAnchor> {
    match raw {
        "nw" => Ok(ResizeAnchor::Nw),
        "ne" => Ok(ResizeAnchor::Ne),
        "sw" => Ok(ResizeAnchor::Sw),
        "se" => Ok(ResizeAnchor::Se),
        _ => Err(CoMotionError::invalid(format!(
            "element resize 不支援的 anchor：{raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_positional(args, 0, "element resize", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element resize", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element resize")?;
    let width = require_number_flag(args, "--width", "element resize")?;
    let height = require_number_flag(args, "--height", "element resize")?;
    let anchor = parse_anchor(optional_flag(args, "--anchor")?.unwrap_or("nw"))?;
    let force = has_flag(args, "--force");

    let slide = write::require_slide(&id, &slide_path)?;
    let fonts = fonts::resolve_presentation_fonts(&id)?;
    let updated = edit::resize_elements(
        &slide.content,
        &slide_path,
        &element_ids,
        width,
        height,
        anchor,
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
