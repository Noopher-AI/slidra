//! `co-motion element distribute` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::arrange::{self, DistributeAxis};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::fonts;
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_axis(raw: &str) -> CoMotionResult<DistributeAxis> {
    match raw {
        "horizontal" => Ok(DistributeAxis::Horizontal),
        "vertical" => Ok(DistributeAxis::Vertical),
        // TS's own wording: `argv.ts`'s distribute branch names the axis
        // parameter "方向" (direction) in this error, not "軸" — copied
        // verbatim (plan decision D5), not a typo to fix here.
        _ => Err(CoMotionError::invalid(format!(
            "element distribute 不支援的方向：{raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_id_positional(args, 0, "element distribute", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element distribute", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element distribute")?;
    let axis = parse_axis(require_positional(args, 3, "element distribute", "axis")?)?;

    let slide = write::require_slide(&id, &slide_path)?;
    let fonts = fonts::resolve_presentation_fonts(&id)?;
    let updated =
        arrange::distribute_elements(&slide.content, &slide_path, &element_ids, axis, &fonts)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("已分佈 {slide_path} 的 {} 個元素", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
