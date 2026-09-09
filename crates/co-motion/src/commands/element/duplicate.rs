//! `co-motion element duplicate` argv layer.

use crate::commands::argv::{
    optional_number_flag, require_id_list, require_id_positional, require_positional,
};
use crate::element::clipboard;
use crate::errors::CoMotionResult;
use crate::id::generate_element_id;
use crate::result::CommandResult;
use crate::workspace::write;

/// Internally the same extract/paste pair `copy`/`paste` use, but routed
/// around the clipboard file entirely so it never overwrites the user's
/// actual clipboard — no `write_clipboard_file`/`read_clipboard_file` call
/// anywhere in this handler.
fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_id_positional(args, 0, "element duplicate", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element duplicate", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element duplicate")?;
    let dx = optional_number_flag(args, "--dx", "element duplicate")?.unwrap_or(0.0);
    let dy = optional_number_flag(args, "--dy", "element duplicate")?.unwrap_or(0.0);

    let slide = write::require_slide(&id, &slide_path)?;
    let payload = clipboard::extract_elements_for_copy(&slide.content, &slide_path, &element_ids)?;
    let result = clipboard::paste_elements(
        &slide.content,
        &slide_path,
        &payload,
        dx,
        dy,
        generate_element_id,
    )?;
    write::write_presentation_file(&id, &slide_path, &result.updated)?;

    Ok(CommandResult::success(
        format!(
            "已在 {slide_path} 複製出 {} 個新元素",
            result.element_ids.len()
        ),
        Some(serde_json::json!({ "elementIds": result.element_ids })),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
