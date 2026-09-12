//! `co-motion font import <presentation-id> <source> --family <name>
//! --license <text> --source <origin> [--license-file <path-or-url>]` —
//! embeds an additional font family in the presentation (#303).
//!
//! The container format has always allowed several families (`project.json`'s
//! `fonts[]`, each `{ file, family, license, licenseFile, source }`), and the
//! write path resolves text metrics per family — but nothing could ADD one:
//! `new` embeds the bundled default and that was the whole book. A style
//! catalogue that varies typography needs this command.
//!
//! `license` and `source` are required because the format requires them: a
//! deck that embeds someone else's font has to carry the terms it was
//! embedded under. A missing licence file is written from `--license`'s own
//! text rather than left blank.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::result::{CommandResult, FailureKind};
use crate::text::font::parse_font;
use crate::workspace::project::{read_project_json, write_project};
use crate::workspace::write::create_presentation_file;
use crate::workspace::{self, list_presentation_entries};
use serde_json::Value;

/// Where an embedded file lives inside the container.
const FONT_DIR: &str = "fonts";

pub fn run(args: &[String]) -> CommandResult {
    match args.first() {
        Some(first) if first == "import" => import(&args[1..]),
        other => CommandResult::failure(
            format!(
                "未知的子命令：font {}",
                other.map(String::as_str).unwrap_or("")
            ),
            FailureKind::Failed,
        ),
    }
}

struct ImportArgs {
    id: String,
    source: String,
    family: String,
    license: String,
    origin: String,
    license_file: Option<String>,
}

fn parse_import(args: &[String]) -> CoMotionResult<ImportArgs> {
    let mut positional: Vec<String> = Vec::new();
    let mut family = None;
    let mut license = None;
    let mut origin = None;
    let mut license_file = None;

    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let take = |slot: &mut Option<String>, flag: &str| -> CoMotionResult<()> {
            let value = args
                .get(index + 1)
                .ok_or_else(|| CoMotionError::invalid(format!("{flag} 缺少值")))?;
            *slot = Some(value.clone());
            Ok(())
        };
        match arg.as_str() {
            "--family" => {
                take(&mut family, "--family")?;
                index += 2;
            }
            "--license" => {
                take(&mut license, "--license")?;
                index += 2;
            }
            "--source" => {
                take(&mut origin, "--source")?;
                index += 2;
            }
            "--license-file" => {
                take(&mut license_file, "--license-file")?;
                index += 2;
            }
            other if other.starts_with("--") => {
                return Err(CoMotionError::invalid(format!("未知的旗標：{other}")));
            }
            other => {
                positional.push(other.to_string());
                index += 1;
            }
        }
    }

    if positional.len() != 2 {
        return Err(CoMotionError::invalid(
            "用法：font import <presentation-id> <來源路徑或 URL> --family <家族名> --license <授權> --source <出處>",
        ));
    }
    let family = family.ok_or_else(|| CoMotionError::invalid("font import 缺少 --family"))?;
    let license = license.ok_or_else(|| CoMotionError::invalid("font import 缺少 --license"))?;
    let origin = origin.ok_or_else(|| CoMotionError::invalid("font import 缺少 --source"))?;
    if family.trim().is_empty() {
        return Err(CoMotionError::invalid("--family 不可為空"));
    }

    Ok(ImportArgs {
        id: positional[0].clone(),
        source: positional[1].clone(),
        family,
        license,
        origin,
        license_file,
    })
}

/// Reads a local path or an `http(s)` URL — the same two shapes
/// `asset import` accepts.
fn read_source(source: &str) -> CoMotionResult<Vec<u8>> {
    if source.starts_with("http://") || source.starts_with("https://") {
        crate::http::download_source(source)
    } else {
        std::fs::read(source)
            .map_err(|_| CoMotionError::not_found(format!("找不到來源檔：{source}")))
    }
}

/// The embedded file is named after the FAMILY, not the source file: the
/// family is unique within a deck by contract, so the name cannot collide
/// with an already-embedded font (naming it after the source would, the
/// moment two sources shared a filename — or the source was the same file
/// the deck already carries). Anything outside `[A-Za-z0-9._-]` becomes `-`.
///
/// The extension comes from the source when it has a recognisable one, so
/// an `.otf` does not end up named `.ttf`.
fn file_name_for(source: &str, family: &str) -> String {
    let path = source.split(['?', '#']).next().unwrap_or(source);
    let extension = ["ttf", "otf", "ttc", "woff2", "woff"]
        .into_iter()
        .find(|ext| path.to_ascii_lowercase().ends_with(&format!(".{ext}")))
        .unwrap_or("ttf");
    let cleaned: String = family
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('-').replace("--", "-");
    let stem = if cleaned.is_empty() { "font".to_string() } else { cleaned };
    format!("{stem}.{extension}")
}

fn import(args: &[String]) -> CommandResult {
    let parsed = match parse_import(args) {
        Ok(parsed) => parsed,
        Err(error) => return CommandResult::from_error(&error),
    };

    // Resolve the presentation first so an unknown id fails as `not-found`
    // before any download happens.
    if let Err(error) = list_presentation_entries(&parsed.id, "") {
        return CommandResult::from_error(&error);
    }
    let work_dir = match workspace::resolve_work_dir(&parsed.id) {
        Ok(dir) => dir,
        Err(error) => return CommandResult::from_error(&error),
    };
    let project = match read_project_json(&work_dir) {
        Ok(project) => project,
        Err(error) => return CommandResult::from_error(&error),
    };

    // A family may only appear once — the format says so, and a duplicate
    // would silently shadow whichever entry parsed first.
    if let Some(fonts) = project.raw.get("fonts").and_then(Value::as_array) {
        if fonts
            .iter()
            .any(|entry| entry.get("family").and_then(Value::as_str) == Some(parsed.family.as_str()))
        {
            return CommandResult::failure(
                format!("簡報已內嵌字型家族：{}", parsed.family),
                FailureKind::Failed,
            );
        }
    }

    let bytes = match read_source(&parsed.source) {
        Ok(bytes) => bytes,
        Err(error) => return CommandResult::from_error(&error),
    };
    // Validate by actually parsing it: an unparseable font would only fail
    // later, in the middle of someone's text edit.
    if let Err(error) = parse_font(&bytes) {
        return CommandResult::from_error(&error);
    }

    let file_name = file_name_for(&parsed.source, &parsed.family);
    let font_path = format!("{FONT_DIR}/{file_name}");
    if let Err(error) = create_presentation_file(&parsed.id, &font_path, &bytes) {
        return CommandResult::from_error(&error);
    }

    // The licence travels with the font. `--license-file` points at the
    // real text when there is one; otherwise `--license`'s own text is
    // written, so the entry never claims a file that says nothing.
    let license_path = format!("{FONT_DIR}/LICENSE-{file_name}.txt");
    let license_bytes = match &parsed.license_file {
        Some(path) => match read_source(path) {
            Ok(bytes) => bytes,
            Err(error) => return CommandResult::from_error(&error),
        },
        None => format!("{}\n來源：{}\n", parsed.license, parsed.origin).into_bytes(),
    };
    if let Err(error) = create_presentation_file(&parsed.id, &license_path, &license_bytes) {
        return CommandResult::from_error(&error);
    }

    let mut raw = project.raw.clone();
    let mut fonts = raw
        .get("fonts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    fonts.push(serde_json::json!({
        "file": font_path,
        "family": parsed.family,
        "license": parsed.license,
        "licenseFile": license_path,
        "source": parsed.origin,
    }));
    raw.insert("fonts".to_string(), Value::Array(fonts));
    if let Err(error) = write_project(&parsed.id, raw) {
        return CommandResult::from_error(&error);
    }

    CommandResult::success(
        format!("已內嵌字型 {}（{}）", parsed.family, font_path),
        Some(serde_json::json!({ "family": parsed.family, "file": font_path, "licenseFile": license_path })),
    )
}
