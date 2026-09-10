//! `co-motion element group` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::group;
use crate::errors::CoMotionResult;
use crate::id::generate_element_id;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_id_positional(args, 0, "element group", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element group", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element group")?;

    let slide = write::require_slide(&id, &slide_path)?;
    let new_group_id = generate_element_id();
    let result = group::group_elements(&slide.content, &slide_path, &element_ids, &new_group_id)?;
    write::write_presentation_file(&id, &slide_path, &result.svg)?;

    let suffix = if result.removed_effects > 0 {
        format!("，並移除 {} 個成員自身的動畫效果", result.removed_effects)
    } else {
        String::new()
    };
    let data = serde_json::json!({
        "elementId": new_group_id,
        "removedEffects": result.removed_effects,
    });
    Ok(CommandResult::success(
        format!(
            "已將 {slide_path} 的 {} 個元素群組為 {new_group_id}{suffix}",
            element_ids.len()
        ),
        Some(data),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
