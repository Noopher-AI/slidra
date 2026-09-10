//! `co-motion element ungroup` argv layer.

use crate::commands::argv::{require_id_list, require_id_positional, require_positional};
use crate::element::group;
use crate::errors::CoMotionResult;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let id = require_id_positional(args, 0, "element ungroup", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element ungroup", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element ungroup")?;

    let slide = write::require_slide(&id, &slide_path)?;
    let result = group::ungroup_elements(&slide.content, &slide_path, &element_ids)?;
    write::write_presentation_file(&id, &slide_path, &result.svg)?;

    let suffix = if result.removed_effects > 0 {
        format!("，並移除 {} 個群組動畫效果", result.removed_effects)
    } else {
        String::new()
    };
    let data = serde_json::json!({
        "elementIds": result.element_ids,
        "removedEffects": result.removed_effects,
    });
    Ok(CommandResult::success(
        format!(
            "已解散 {slide_path} 的 {} 個群組{suffix}",
            element_ids.len()
        ),
        Some(data),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
