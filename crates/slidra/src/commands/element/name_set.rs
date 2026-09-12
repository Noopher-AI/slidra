//! `slidra element name set` argv layer. Unlike `argv.ts`'s runtime
//! `sub === "name"` then `args[0] !== "set"` check, `resolve_takeover`
//! already matched the full three-token `["element", "name", "set"]`
//! sequence before this handler is ever reached (plan section 1.4) — there
//! is no "element name <anything-else>" case left to reject here.

use crate::commands::argv::{
    require_id_list, require_id_positional, require_positional, require_raw_positional,
};
use crate::element::group;
use crate::errors::SlidraResult;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element name set", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element name set", "slide-path")?.to_string();
    let element_ids = require_id_list(args, 2, "element name set")?;
    // Raw positional, not `require_positional`: an empty string clears the
    // display name (legal), and a flag-shaped value like `"--force"` is
    // also a legal literal name — `argv.ts` fetches this by bare index
    // (`nameArgs[3]`) rather than through its flag-rejecting helper.
    let name = require_raw_positional(args, 3, "element name set", "name")?.to_string();

    let slide = write::require_slide(&id, &slide_path)?;
    let updated = group::set_element_name(&slide.content, &slide_path, &element_ids, &name)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    Ok(CommandResult::success(
        format!(
            "已設定 {slide_path} 的 {} 個元素的顯示名稱",
            element_ids.len()
        ),
        Some(serde_json::json!({})),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
