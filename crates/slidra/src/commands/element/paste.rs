//! `slidra element paste` argv layer.

use crate::commands::argv::{
    optional_flag, optional_number_flag, require_id_positional, require_positional,
};
use crate::element::clipboard;
use crate::errors::{SlidraError, SlidraResult};
use crate::id::generate_element_id;
use crate::result::CommandResult;
use crate::workspace::write;

fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
    let id = require_id_positional(args, 0, "element paste", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 1, "element paste", "slide-path")?.to_string();
    let dx = optional_number_flag(args, "--dx", "element paste")?.unwrap_or(0.0);
    let dy = optional_number_flag(args, "--dy", "element paste")?.unwrap_or(0.0);
    let svg_file = optional_flag(args, "--svg-file")?;

    // `--svg-file` is read from the LOCAL filesystem by the CLI layer
    // itself, before any presentation/slide validation — mirrors
    // `packages/cli/src/commands/element/paste.ts`'s own
    // `readSvgFile(input.svgFile)` call, which runs before it ever invokes
    // `pasteSlideClipboard`. Without `--svg-file`, the internal clipboard
    // file is read AFTER slide validation instead (inside
    // `pasteSlideClipboard` itself) — the two branches deliberately check
    // things in a different order, not an oversight to "fix" into matching.
    let svg_from_file = match svg_file {
        Some(path) => Some(
            std::fs::read_to_string(path)
                .map_err(|_| SlidraError::invalid(format!("找不到來源檔案：{path}")))?,
        ),
        None => None,
    };

    let slide = write::require_slide(&id, &slide_path)?;

    let payload = match svg_from_file {
        Some(svg) => clipboard::parse_clipboard_svg(&svg)
            .ok_or_else(|| SlidraError::invalid("剪貼簿內容不是合法的 slidra 元素剪貼簿格式"))?,
        None => {
            let raw = write::read_clipboard_file(&id)?;
            serde_json::from_str(&raw).map_err(|_| SlidraError::invalid("剪貼簿資料已損毀"))?
        }
    };

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
        format!("已貼上 {} 個元素到 {slide_path}", result.element_ids.len()),
        Some(serde_json::json!({ "elementIds": result.element_ids })),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
