// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `slidra element distribute` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::arrange::{self, DistributeAxis};
use crate::errors::{SlidraError, SlidraResult};
use crate::fonts;
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_axis(raw: &str) -> SlidraResult<DistributeAxis> {
    match raw {
        "horizontal" => Ok(DistributeAxis::Horizontal),
        "vertical" => Ok(DistributeAxis::Vertical),
        // This error intentionally names the axis parameter "direction",
        // not "axis" — not a typo to fix here.
        _ => Err(SlidraError::invalid(format!(
            "element distribute unsupported direction: {raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
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
        format!("distributed {} elements in {slide_path}", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
