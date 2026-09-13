// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra element order` argv layer.

use crate::commands::argv::{has_flag, require_id_list, require_id_positional, require_positional};
use crate::element::edit::{self, OrderDirection};
use crate::errors::{SlidraError, SlidraResult};
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_direction(raw: &str) -> SlidraResult<OrderDirection> {
    match raw {
        "front" => Ok(OrderDirection::Front),
        "back" => Ok(OrderDirection::Back),
        "up" => Ok(OrderDirection::Up),
        "down" => Ok(OrderDirection::Down),
        _ => Err(SlidraError::invalid(format!(
            "element order unsupported direction: {raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
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
            "adjusted stacking order of {} elements in {slide_path}",
            element_ids.len()
        ),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
