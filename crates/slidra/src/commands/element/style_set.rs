//! `slidra element style set` argv layer. Named `style_set` (not
//! `style::set`) — the family's `dispatch` routes on the two-token
//! `["style", "set"]` suffix directly, mirroring `commands::element::name_set`'s
//! same naming choice for `element name set`.

use crate::commands::argv::{
    has_flag, require_id_list, require_id_positional, require_positional, require_raw_positional,
};
use crate::element::edit;
use crate::errors::SlidraResult;
use crate::fonts;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element style set", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element style set", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element style set")?;
    let attr = require_positional(args, 3, "element style set", "attr")?.to_string();
    // `value` is a "verbatim last positional" (see `require_raw_positional`'s
    // doc comment, which names this exact call site): an empty string or a
    // flag-shaped literal (`--force`) are both legal style values, not
    // missing-argument errors.
    let value = require_raw_positional(args, 4, "element style set", "value")?.to_string();
    let force = has_flag(args, "--force");

    let slide = write::require_slide(&id, &slide_path)?;
    let fonts = fonts::resolve_presentation_fonts(&id)?;
    let updated = edit::set_element_style(
        &slide.content,
        &slide_path,
        &element_ids,
        &attr,
        &value,
        &fonts,
        force,
    )?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!(
            "已設定 {slide_path} 的 {} 個元素的 {attr}",
            element_ids.len()
        ),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
