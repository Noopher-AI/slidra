// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `slidra element align` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::arrange::{self, AlignDirection};
use crate::errors::{SlidraError, SlidraResult};
use crate::fonts;
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_direction(raw: &str) -> SlidraResult<AlignDirection> {
    match raw {
        "left" => Ok(AlignDirection::Left),
        "hcenter" => Ok(AlignDirection::HCenter),
        "right" => Ok(AlignDirection::Right),
        "top" => Ok(AlignDirection::Top),
        "vcenter" => Ok(AlignDirection::VCenter),
        "bottom" => Ok(AlignDirection::Bottom),
        _ => Err(SlidraError::invalid(format!(
            "element align unsupported direction: {raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element align", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element align", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element align")?;
    let direction = parse_direction(require_positional(args, 3, "element align", "direction")?)?;

    let slide = write::require_slide(&id, &slide_path)?;
    let fonts = fonts::resolve_presentation_fonts(&id)?;
    let updated =
        arrange::align_elements(&slide.content, &slide_path, &element_ids, direction, &fonts)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("aligned {} elements in {slide_path}", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
