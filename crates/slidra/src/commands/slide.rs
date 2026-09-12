//! `slidra slide add|set|delete|duplicate|move|notes set|style set|
//! transition set|render`.

use crate::argv;
use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::slide::ingest;
use crate::slide::ops::{self, AddSlideInput, SetSlideTransitionOnInput};
use crate::slide::style::PageStyleUpdate;
use crate::slide::transition::PageTransitionEffect;
use crate::validate;
use crate::workspace::{self, project::read_project_json, virtual_fs, write as ws_write};

pub fn run(args: &[String], json_flag: bool) -> CommandResult {
    let sub = args.first().map(String::as_str);
    let rest: &[String] = args.get(1..).unwrap_or(&[]);

    match sub {
        Some("render") => run_render(rest, json_flag),
        Some("add") => run_add(rest),
        Some("set") => run_set(rest),
        Some("delete") => run_delete(rest),
        Some("duplicate") => run_duplicate(rest),
        Some("move") => run_move(rest),
        Some("notes") => run_notes(rest),
        Some("transition") => run_transition(rest),
        Some("style") => run_style(rest),
        Some("background") => run_background(rest),
        other => CommandResult::failure(
            format!("unknown subcommand: slide {}", other.unwrap_or("")),
            FailureKind::Failed,
        ),
    }
}

/// `slide render`'s data has the same `{ content }` shape `cat` renders —
/// reused verbatim so `main.rs` attaches the same byte-for-byte renderer.
pub fn render(data: &serde_json::Value) -> Vec<u8> {
    crate::commands::cat::render(data)
}

fn failure_kind_for(err: &SlidraError) -> FailureKind {
    match err {
        SlidraError::NotFound(_) => FailureKind::NotFound,
        SlidraError::InvalidRequest(_) => FailureKind::Failed,
    }
}

fn run_render(args: &[String], json_flag: bool) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "slide render", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let path = match argv::require_positional(args, 1, "slide render", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match render_slide_for_display(&id, &path) {
        // `docs/spec/cli.md`'s renderer contract ("rendering rules are
        // exactly the same as `cat`"):
        // under `--json` the raw bytes go through `crate::base64::encode`
        // (see `cat::run`'s json_flag branch); the non-`--json` path keeps
        // the raw string so `render()` above still writes it byte-for-byte.
        Ok(content) => {
            let content_value = if json_flag {
                serde_json::Value::String(crate::base64::encode(content.as_bytes()))
            } else {
                serde_json::Value::String(content)
            };
            CommandResult::success(
                format!("rendered: {path}"),
                Some(serde_json::json!({ "content": content_value })),
            )
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn render_slide_for_display(id: &str, slide_path: &str) -> Result<String, SlidraError> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    let project = read_project_json(&work_dir)?;
    if !project.slides.contains(&slide_path.to_string()) {
        return Err(SlidraError::invalid(format!("not a slide: {slide_path}")));
    }
    let original = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
    let slide_number = project
        .slides
        .iter()
        .position(|s| s == slide_path)
        .map(|i| i + 1)
        .unwrap_or(0);
    let mut variables = std::collections::HashMap::new();
    variables.insert("slide_number".to_string(), slide_number.to_string());
    variables.insert("slide_total".to_string(), project.slides.len().to_string());
    variables.insert(
        "presentation_name".to_string(),
        crate::text::escape::escape_xml_text(&project.name),
    );
    Ok(crate::text::dynamic::substitute_dynamic_text(
        &original, &variables,
    ))
}

fn run_add(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "slide add", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let template_path = match argv::optional_flag(args, "--template") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let at = match argv::optional_flag(args, "--at") {
        Ok(Some(raw)) => match raw.parse::<f64>() {
            Ok(v) if v.is_finite() => Some(v),
            _ => {
                return CommandResult::failure(
                    format!("--at is not a valid number: {raw}"),
                    FailureKind::Failed,
                );
            }
        },
        Ok(None) => None,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let svg = match argv::optional_flag(args, "--svg") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    if svg.is_some() && template_path.is_some() {
        return CommandResult::failure(
            "--svg and --template cannot be used together".to_string(),
            FailureKind::Failed,
        );
    }
    // `--svg` (#303): the agent authors the whole page; ingest it against
    // this presentation's canvas and fonts before anything is written.
    let ingested = match svg {
        Some(raw) => match add_index(&id, at).and_then(|index| {
            // The page is judged at the position it will occupy — `--at`
            // inserts, so the pages after it shift and this one is the
            // (index + 1)-th, not the last.
            ingest_for(
                &id,
                &raw,
                &format!("slides/{:03}.svg", index + 1),
                Some(index),
            )
        }) {
            Ok(v) => Some(v),
            Err(err) => {
                return CommandResult::failure(err.message().to_string(), failure_kind_for(&err));
            }
        },
        None => None,
    };
    let content = ingested.as_ref().map(|i| i.svg.clone());
    match ops::add_slide(
        &id,
        AddSlideInput {
            template_path,
            at,
            content,
        },
    ) {
        Ok(result) => match ingested {
            Some(ingested) => CommandResult::success(
                format!(
                    "wrote {} ({} elements)",
                    result.slide_path,
                    ingested.element_ids.len()
                ),
                Some(serde_json::json!({
                    "slidePath": result.slide_path,
                    "elementIds": ingested.element_ids,
                })),
            ),
            None => CommandResult::success(
                format!("added slide {}", result.slide_path),
                Some(serde_json::json!({ "slidePath": result.slide_path })),
            ),
        },
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// Where `slide add` will put the new page: `--at` when given, otherwise
/// the end of the running order.
fn add_index(id: &str, at: Option<f64>) -> Result<usize, SlidraError> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    Ok(match at {
        Some(value) => (value as usize).min(project.slides.len()),
        None => project.slides.len(),
    })
}

/// Where an existing path sits in the running order, or `None` when it is
/// not a page of this deck (a template).
fn slide_index(id: &str, slide_path: &str) -> Result<Option<usize>, SlidraError> {
    let project = read_project_json(&workspace::resolve_work_dir(id)?)?;
    Ok(project.slides.iter().position(|path| path == slide_path))
}

/// Ingests agent-authored page markup for this presentation (canvas from
/// `project.json`, fonts from the container) and puts the result through the
/// write gate — shared by `slide add --svg` and `slide set --svg`.
///
/// `at` is the 0-based position the page will occupy, or `None` when the
/// target is a template rather than a page of this deck: a template has no
/// place in the running order, so there is no page number to report and no
/// outline entry to judge it against, and it was already gated as the page
/// `template add --from` copied it from.
fn ingest_for(
    id: &str,
    raw: &str,
    slide_path: &str,
    at: Option<usize>,
) -> Result<ingest::IngestResult, SlidraError> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let project = read_project_json(&work_dir)?;
    let fonts = crate::fonts::resolve_presentation_fonts(id)?;
    let ingested =
        ingest::ingest_slide_svg(raw, project.canvas.width, project.canvas.height, &fonts)?;
    if let Some(index) = at {
        let refused = validate::check_authored_page(id, index, slide_path, &ingested.svg)?;
        if !refused.is_empty() {
            return Err(SlidraError::invalid(describe_refusal(&refused)));
        }
    }
    Ok(ingested)
}

/// The refusal an author can act on without running anything else: every
/// rule the page breaks, in `validate`'s own wording, plus the line that
/// says what was *not* checked — so a page is not rewritten again over an
/// animation that was never this command's business.
fn describe_refusal(refused: &[validate::ValidationError]) -> String {
    let lines: Vec<String> = refused
        .iter()
        .map(|error| format!("- {}（{}）", error.message, error.rule))
        .collect();
    format!(
        "this page was not written: {} rule(s) still fail, fix and resubmit.\n{}\n(only validates the content of this page itself; transition, entrance effect, speaker notes, template, blueprint are commands applied after writing and are not blocked here. see reference/slide-design.md section 9 for how to fix.)",
        refused.len(),
        lines.join("\n")
    )
}

/// `slide set <id> <slide-path> --svg '<full-page SVG>'`: overwrites one
/// existing slide (or template) with an agent-authored page. The old page's
/// `<metadata>` survives when the new markup has none. Written through the
/// one history-recording door, so undo restores the previous page.
fn run_set(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "slide set", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(args, 1, "slide set", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let raw = match argv::optional_flag(args, "--svg") {
        Ok(Some(v)) => v,
        Ok(None) => {
            return CommandResult::failure(
                "command slide set missing argument: --svg".to_string(),
                FailureKind::Failed,
            );
        }
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let result = (|| -> Result<ingest::IngestResult, SlidraError> {
        let existing = ws_write::require_slide(&id, &slide_path)?;
        let ingested = ingest_for(&id, &raw, &slide_path, slide_index(&id, &slide_path)?)?;
        let with_metadata = ingest::carry_metadata(&ingested.svg, &existing.content)?;
        ws_write::write_presentation_file(&id, &slide_path, &with_metadata)?;
        Ok(ingest::IngestResult {
            svg: with_metadata,
            element_ids: ingested.element_ids,
        })
    })();
    match result {
        Ok(ingested) => CommandResult::success(
            format!(
                "wrote {slide_path} ({} elements)",
                ingested.element_ids.len()
            ),
            Some(serde_json::json!({
                "slidePath": slide_path,
                "elementIds": ingested.element_ids,
            })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_delete(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "slide delete", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(args, 1, "slide delete", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::delete_slide(&id, &slide_path) {
        Ok(()) => CommandResult::success(
            format!("deleted slide {slide_path}"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_duplicate(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "slide duplicate", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(args, 1, "slide duplicate", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::duplicate_slide(&id, &slide_path) {
        Ok(result) => CommandResult::success(
            format!("duplicated slide as {}", result.slide_path),
            Some(serde_json::json!({ "slidePath": result.slide_path })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_move(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "slide move", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(args, 1, "slide move", "slide-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let new_index_raw = match argv::require_positional(args, 2, "slide move", "new-index") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let Ok(new_index) = new_index_raw.parse::<f64>() else {
        return CommandResult::failure(
            format!("command slide move\'s new-index is not a valid number: {new_index_raw}"),
            FailureKind::Failed,
        );
    };
    if !new_index.is_finite() {
        return CommandResult::failure(
            format!("command slide move\'s new-index is not a valid number: {new_index_raw}"),
            FailureKind::Failed,
        );
    }
    match ops::move_slide(&id, &slide_path, new_index) {
        Ok(()) => CommandResult::success(
            format!("moved slide {slide_path}"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_notes(args: &[String]) -> CommandResult {
    let subsub = args.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!("unknown subcommand: slide notes {}", subsub.unwrap_or("")),
            FailureKind::Failed,
        );
    }
    let notes_args: &[String] = args.get(1..).unwrap_or(&[]);
    let id = match argv::require_id_positional(notes_args, 0, "slide notes set", "presentation-id")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(notes_args, 1, "slide notes set", "slide-path")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    // text may legitimately be an empty string (clears the notes) — checked
    // for absence, not falsiness.
    let Some(text) = notes_args.get(2) else {
        return CommandResult::failure(
            "command slide notes set missing argument: text".to_string(),
            FailureKind::Failed,
        );
    };
    match ops::set_notes(&id, &slide_path, text) {
        Ok(()) => CommandResult::success(
            format!("updated speaker notes of {slide_path}"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_transition(args: &[String]) -> CommandResult {
    let subsub = args.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!(
                "unknown subcommand: slide transition {}",
                subsub.unwrap_or("")
            ),
            FailureKind::Failed,
        );
    }
    let trans_args: &[String] = args.get(1..).unwrap_or(&[]);
    let id =
        match argv::require_id_positional(trans_args, 0, "slide transition set", "presentation-id")
        {
            Ok(v) => v,
            Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
        };
    let slide_path =
        match argv::require_positional(trans_args, 1, "slide transition set", "slide-path") {
            Ok(v) => v,
            Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
        };

    let enter = match parse_effect_flag(trans_args, "--enter", "enter") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let exit = match parse_effect_flag(trans_args, "--exit", "exit") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let enter_duration = match argv::optional_number_flag(trans_args, "--enter-duration") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let exit_duration = match argv::optional_number_flag(trans_args, "--exit-duration") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let all = argv::has_flag(trans_args, "--all");

    if enter.is_none()
        && enter_duration.is_none()
        && exit.is_none()
        && exit_duration.is_none()
        && !all
    {
        return CommandResult::failure(
            "slide transition set must specify at least one field to change".to_string(),
            FailureKind::Failed,
        );
    }

    let input = SetSlideTransitionOnInput {
        enter,
        enter_duration,
        exit,
        exit_duration,
        all,
    };
    match ops::set_slide_transition_on(&id, &slide_path, input) {
        Ok(slide_count) => {
            let message = if all {
                format!("applied page transitions to {slide_count} slides")
            } else {
                format!("set page transitions of {slide_path}")
            };
            CommandResult::success(message, Some(serde_json::json!({})))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn parse_effect_flag(
    args: &[String],
    flag: &str,
    label: &str,
) -> Result<Option<PageTransitionEffect>, String> {
    let Some(raw) = argv::optional_flag(args, flag)? else {
        return Ok(None);
    };
    PageTransitionEffect::parse(&raw)
        .map(Some)
        .ok_or_else(|| format!("slide transition set unsupported {label}: {raw}"))
}

fn run_style(args: &[String]) -> CommandResult {
    let subsub = args.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!("unknown subcommand: slide style {}", subsub.unwrap_or("")),
            FailureKind::Failed,
        );
    }
    let style_args: &[String] = args.get(1..).unwrap_or(&[]);
    let id = match argv::require_id_positional(style_args, 0, "slide style set", "presentation-id")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let slide_path = match argv::require_positional(style_args, 1, "slide style set", "slide-path")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let background = match argv::optional_flag(style_args, "--background") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let accent = match argv::optional_flag(style_args, "--accent") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    if background.is_none() && accent.is_none() {
        return CommandResult::failure(
            "command slide style set requires at least --background or --accent".to_string(),
            FailureKind::Failed,
        );
    }

    match set_slide_page_style(&id, &slide_path, PageStyleUpdate { background, accent }) {
        Ok(()) => CommandResult::success(
            format!("set page style of {slide_path}"),
            Some(serde_json::json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// `slide background set <id> <slide-path> --asset assets/x.svg [--opacity n]`
/// / `--none` (#303 §13): a locked full-canvas `<image>` at the back of the
/// page, or its removal. Goes through history like `slide style set`.
fn run_background(args: &[String]) -> CommandResult {
    let subsub = args.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!(
                "unknown subcommand: slide background {}",
                subsub.unwrap_or("")
            ),
            FailureKind::Failed,
        );
    }
    let bg_args: &[String] = args.get(1..).unwrap_or(&[]);
    let id =
        match argv::require_id_positional(bg_args, 0, "slide background set", "presentation-id") {
            Ok(v) => v,
            Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
        };
    let slide_path =
        match argv::require_positional(bg_args, 1, "slide background set", "slide-path") {
            Ok(v) => v,
            Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
        };
    let asset = match argv::optional_flag(bg_args, "--asset") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let opacity = match argv::optional_number_flag(bg_args, "--opacity") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let none = argv::has_flag(bg_args, "--none");
    if asset.is_some() == none {
        return CommandResult::failure(
            "command slide background set requires either --asset or --none".to_string(),
            FailureKind::Failed,
        );
    }
    let result = (|| -> Result<Option<String>, SlidraError> {
        let existing = ws_write::require_slide(&id, &slide_path)?;
        let updated = match asset.as_deref() {
            Some(asset_path) => {
                if !asset_path.starts_with("assets/") {
                    return Err(SlidraError::invalid(format!(
                        "--asset must be a virtual path under assets/: {asset_path}"
                    )));
                }
                virtual_fs::resolve_virtual_file_path(&existing.work_dir, asset_path)?;
                crate::slide::background::set_background(
                    &existing.content,
                    asset_path,
                    existing.project.canvas.width,
                    existing.project.canvas.height,
                    opacity,
                )?
            }
            None => crate::slide::background::clear_background(&existing.content)?,
        };
        ws_write::write_presentation_file(&id, &slide_path, &updated)?;
        Ok(asset.map(|_| crate::slide::background::BACKGROUND_ELEMENT_ID.to_string()))
    })();
    match result {
        Ok(Some(element_id)) => CommandResult::success(
            format!("set background image of {slide_path}"),
            Some(serde_json::json!({ "elementId": element_id })),
        ),
        Ok(None) => CommandResult {
            ok: true,
            data: None,
            message: format!("removed background image of {slide_path}"),
            failure_kind: None,
        },
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// `slide style set` — unlike `presentation canvas set`, this goes through
/// history (undo).
fn set_slide_page_style(
    id: &str,
    slide_path: &str,
    update: PageStyleUpdate,
) -> Result<(), SlidraError> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    let project = read_project_json(&work_dir)?;
    let templates = crate::workspace::project::read_template_entries(&project);
    if !project.slides.contains(&slide_path.to_string())
        && !templates.iter().any(|t| t.file == slide_path)
    {
        return Err(SlidraError::invalid(format!("not a slide: {slide_path}")));
    }
    let original = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
    let updated = crate::slide::style::set_slide_page_style(&original, &update)?;
    ws_write::write_presentation_file(id, slide_path, &updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_subcommand_fails_with_trailing_space() {
        let result = run(&[], false);
        assert!(!result.ok);
        assert_eq!(result.message, "unknown subcommand: slide ");
    }

    #[test]
    fn unknown_notes_subcommand_fails() {
        let result = run(&["notes".to_string(), "frobnicate".to_string()], false);
        assert!(!result.ok);
        assert_eq!(result.message, "unknown subcommand: slide notes frobnicate");
    }

    #[test]
    fn notes_set_missing_text_fails() {
        let result = run(
            &[
                "notes".to_string(),
                "set".to_string(),
                "id".to_string(),
                "slides/001.svg".to_string(),
            ],
            false,
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command slide notes set missing argument: text"
        );
    }

    #[test]
    fn transition_set_no_fields_fails() {
        let result = run(
            &[
                "transition".to_string(),
                "set".to_string(),
                "id".to_string(),
                "slides/001.svg".to_string(),
            ],
            false,
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "slide transition set must specify at least one field to change"
        );
    }

    #[test]
    fn transition_set_invalid_enter_fails() {
        let result = run(
            &[
                "transition".to_string(),
                "set".to_string(),
                "id".to_string(),
                "slides/001.svg".to_string(),
                "--enter".to_string(),
                "bogus".to_string(),
            ],
            false,
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "slide transition set unsupported enter: bogus"
        );
    }

    #[test]
    fn style_set_neither_flag_fails() {
        let result = run(
            &[
                "style".to_string(),
                "set".to_string(),
                "id".to_string(),
                "slides/001.svg".to_string(),
            ],
            false,
        );
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command slide style set requires at least --background or --accent"
        );
    }
}
