//! `co-motion element align` argv layer.

use crate::commands::argv::{require_id_list, require_positional};
use crate::element::arrange::{self, AlignDirection};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::fonts;
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_direction(raw: &str) -> CoMotionResult<AlignDirection> {
    match raw {
        "left" => Ok(AlignDirection::Left),
        "hcenter" => Ok(AlignDirection::HCenter),
        "right" => Ok(AlignDirection::Right),
        "top" => Ok(AlignDirection::Top),
        "vcenter" => Ok(AlignDirection::VCenter),
        "bottom" => Ok(AlignDirection::Bottom),
        _ => Err(CoMotionError::invalid(format!(
            "element align 不支援的方向：{raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_positional(args, 0, "element align", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element align", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element align")?;
    let direction = parse_direction(require_positional(args, 3, "element align", "direction")?)?;

    let slide = write::require_slide(&id, &slide_path)?;
    let fonts = fonts::resolve_presentation_fonts(&id)?;
    let updated =
        arrange::align_elements(&slide.content, &slide_path, &element_ids, direction, &fonts)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("已對齊 {slide_path} 的 {} 個元素", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
