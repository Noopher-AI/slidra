//! `comotion element order` argv layer.

use crate::commands::argv::{has_flag, require_id_list, require_id_positional, require_positional};
use crate::element::edit::{self, OrderDirection};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_direction(raw: &str) -> CoMotionResult<OrderDirection> {
    match raw {
        "front" => Ok(OrderDirection::Front),
        "back" => Ok(OrderDirection::Back),
        "up" => Ok(OrderDirection::Up),
        "down" => Ok(OrderDirection::Down),
        _ => Err(CoMotionError::invalid(format!(
            "element order 不支援的方向：{raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_id_positional(args, 0, "element order", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element order", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element order")?;
    let direction = parse_direction(require_positional(args, 3, "element order", "direction")?)?;
    let force = has_flag(args, "--force");

    let slide = write::require_slide(&id, &slide_path)?;
    let updated =
        edit::reorder_elements(&slide.content, &slide_path, &element_ids, direction, force)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!(
            "已調整 {slide_path} 的 {} 個元素的疊置順序",
            element_ids.len()
        ),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
