// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `slidra element delete` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::edit;
use crate::errors::SlidraResult;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element delete", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element delete", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element delete")?;

    let slide = write::require_slide(&id, &slide_path)?;
    let updated = edit::delete_elements(&slide.content, &slide_path, &element_ids)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!("deleted {} elements in {slide_path}", element_ids.len()),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
