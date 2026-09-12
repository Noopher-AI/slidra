//! `comotion element insert` argv layer — mirrors `packages/cli/src/
//! commands/element/insert.ts` + the `"insert"` branch of `argv.ts`'s
//! `case "element":`. `kind` is validated here, at the argv layer, exactly
//! where TS validates it too (`docs/spec/cli.md`'s `element insert` entry:
//! "not being one of this set errors out directly at the argv parsing
//! stage") — the pure core layer
//! (`element::edit::insert_element`) receives only an already-valid
//! `InsertElementKind`, so its own kind dispatch has no "unsupported kind"
//! arm to fall through to (the Rust type system enforces what TS's runtime
//! default-case throw enforces dynamically).

use crate::commands::argv::{
    optional_flag, optional_number_flag, require_id_positional, require_positional,
};
use crate::element::edit::{self, InsertElementInput, InsertElementKind};
use crate::errors::{CoMotionError, CoMotionResult};
use crate::id::generate_element_id;
use crate::result::CommandResult;
use crate::workspace::write;

fn parse_kind(raw: &str) -> CoMotionResult<InsertElementKind> {
    match raw {
        "rect" => Ok(InsertElementKind::Rect),
        "ellipse" => Ok(InsertElementKind::Ellipse),
        "line" => Ok(InsertElementKind::Line),
        "image" => Ok(InsertElementKind::Image),
        "path" => Ok(InsertElementKind::Path),
        "video" => Ok(InsertElementKind::Video),
        "audio" => Ok(InsertElementKind::Audio),
        _ => Err(CoMotionError::invalid(format!(
            "element insert 不支援的 kind：{raw}"
        ))),
    }
}

fn try_run(args: &[String]) -> CoMotionResult<CommandResult> {
    let kind = parse_kind(require_positional(args, 0, "element insert", "kind")?)?;
    let id = require_id_positional(args, 1, "element insert", "presentation-id")?.to_string();
    let slide_path = require_positional(args, 2, "element insert", "slide-path")?.to_string();

    let input = InsertElementInput {
        x: optional_number_flag(args, "--x", "element insert")?,
        y: optional_number_flag(args, "--y", "element insert")?,
        width: optional_number_flag(args, "--width", "element insert")?,
        height: optional_number_flag(args, "--height", "element insert")?,
        x1: optional_number_flag(args, "--x1", "element insert")?,
        y1: optional_number_flag(args, "--y1", "element insert")?,
        x2: optional_number_flag(args, "--x2", "element insert")?,
        y2: optional_number_flag(args, "--y2", "element insert")?,
        d: optional_flag(args, "--d")?.map(str::to_string),
        fill: optional_flag(args, "--fill")?.map(str::to_string),
        stroke: optional_flag(args, "--stroke")?.map(str::to_string),
        stroke_width: optional_number_flag(args, "--stroke-width", "element insert")?,
        href: optional_flag(args, "--href")?.map(str::to_string),
        media: optional_flag(args, "--media")?.map(str::to_string),
        embed: optional_flag(args, "--embed")?.map(str::to_string),
    };

    let slide = write::require_slide(&id, &slide_path)?;
    let element_id = generate_element_id();
    let updated = edit::insert_element(&slide.content, &slide_path, &element_id, &input, kind)?;
    write::write_presentation_file(&id, &slide_path, &updated)?;

    let data = serde_json::json!({ "elementId": element_id });
    Ok(CommandResult::success(
        format!("已在 {slide_path} 新增元素 {element_id}"),
        Some(data),
    ))
}

pub fn run(args: &[String]) -> CommandResult {
    try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
}
