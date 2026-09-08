//! Reading and structurally validating `project.json`. Ported from
//! `packages/core/src/project-json.ts` (full file) plus the read-only half
//! of `packages/core/src/workspace.ts`'s internal `readProjectJson`.
//!
//! Public API:
//! - `read_project_json(work_dir) -> CoMotionResult<ProjectJson>` — reads
//!   `project.json` through `virtual_fs::read_virtual_file`, JSON-parses it,
//!   and runs the same structural validation `validateProjectJson` (TS) does
//!   before `open`/`serve` ever load a presentation.
//! - `read_template_entries(&ProjectJson) -> Vec<TemplateEntry>` — the one
//!   sanctioned way to read `templates`, normalizing the pre-upgrade
//!   bare-string shape.
//! - `ProjectJson` — `format_version`/`name`/`canvas`/`slides` as typed
//!   convenience views, plus `raw`: the *entire* original top-level object,
//!   order-preserved (via `serde_json`'s `preserve_order` feature). This
//!   deliberately differs from the ticket's suggested `#[serde(flatten)]
//!   extra: Map<...>` sketch: flatten only preserves order *within* the
//!   flattened map, not the interleaving of unknown fields among known ones
//!   (`formatVersion`, `name`, ... would always serialize before any
//!   flattened extra field, regardless of where they sat in the source
//!   file). Keeping the one true `raw` map as the read-then-write-back
//!   source of truth, with typed fields as read-only views extracted from
//!   it, preserves every field's exact original position — not just the
//!   unknown ones — which is a strictly stronger guarantee than flatten
//!   gives and is what "round-trips a float value exactly" actually needs
//!   downstream, since nothing here ever reconstructs the object from parts.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::workspace::virtual_fs;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Canvas {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone)]
pub struct ProjectJson {
    pub format_version: f64,
    pub name: String,
    pub canvas: Canvas,
    pub slides: Vec<String>,
    /// The full original top-level object, exactly as parsed — including
    /// `formatVersion`/`name`/`canvas`/`slides` themselves, any optional
    /// `fonts`/`templates`/`transition`, and any field this build has never
    /// heard of. Order-preserved. See module doc for why this — not a
    /// flattened "extra" map — is the round-trip source of truth.
    pub raw: serde_json::Map<String, Value>,
}

/// One entry of `project.json`'s `templates`, as normalized by
/// `read_template_entries`. Never read `project.raw["templates"]` directly —
/// it may still hold the pre-upgrade bare-string shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateEntry {
    /// Virtual path inside the container, e.g. "templates/001.svg".
    pub file: String,
    /// User-visible name. May be any non-empty string; two templates may
    /// share one (A6).
    pub name: String,
}

/// Reads and parses `project.json`, shared by every caller that needs its
/// structure. Mirrors workspace.ts's private `readProjectJson` for the parse
/// failure (`簡報設定檔已損毀` — that function never ran
/// `validateProjectJson` at all), then additionally runs the full
/// `validateProjectJson` structural check so a caller here gets the same
/// field-precise errors `open`/`serve` do in TS, not just "this happens to
/// have a `slides` array."
pub fn read_project_json(work_dir: &Path) -> CoMotionResult<ProjectJson> {
    let text = virtual_fs::read_virtual_file(work_dir, "project.json")?;
    let value: Value =
        serde_json::from_str(&text).map_err(|_| CoMotionError::invalid("簡報設定檔已損毀"))?;
    let obj = validate_project_json(&value)?;

    let format_version = obj
        .get("formatVersion")
        .and_then(Value::as_f64)
        .expect("validated as number");
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .expect("validated as string")
        .to_string();
    let canvas_obj = obj
        .get("canvas")
        .and_then(Value::as_object)
        .expect("validated as object");
    let canvas = Canvas {
        width: canvas_obj
            .get("width")
            .and_then(Value::as_f64)
            .expect("validated as number"),
        height: canvas_obj
            .get("height")
            .and_then(Value::as_f64)
            .expect("validated as number"),
    };
    let slides = obj
        .get("slides")
        .and_then(Value::as_array)
        .expect("validated as array")
        .iter()
        .map(|s| s.as_str().expect("validated as string").to_string())
        .collect();

    Ok(ProjectJson {
        format_version,
        name,
        canvas,
        slides,
        raw: obj.clone(),
    })
}

/// The `container.rs`-facing entry point: runs the same structural check
/// `read_project_json` runs, discarding the parsed fields — `unpack_container`
/// only needs to know the file is well-formed, not read it back apart.
pub fn validate_project_json_value(value: &Value) -> CoMotionResult<()> {
    validate_project_json(value)?;
    Ok(())
}

/// Structural validation of an already-JSON-parsed `project.json`, ported
/// from `validateProjectJson`. An empty `slides` array is structurally
/// valid. Unknown extra fields are accepted, never rejected (forward
/// compatibility, ADR-0003). Never includes a filesystem path (ADR-0004).
fn validate_project_json(value: &Value) -> CoMotionResult<&serde_json::Map<String, Value>> {
    // `Value::as_object()` returns `None` for a JSON array too (arrays and
    // objects are distinct `Value` variants here, unlike JS where
    // `typeof [] === "object"`), so this one check also covers the TS
    // original's separate `Array.isArray(value)` branch.
    let obj = value
        .as_object()
        .ok_or_else(|| CoMotionError::invalid("project.json 格式錯誤：內容不是物件"))?;

    if !matches!(obj.get("formatVersion"), Some(Value::Number(_))) {
        return Err(CoMotionError::invalid(
            "project.json 格式錯誤：缺少或型別錯誤的 formatVersion",
        ));
    }
    if !matches!(obj.get("name"), Some(Value::String(_))) {
        return Err(CoMotionError::invalid(
            "project.json 格式錯誤：缺少或型別錯誤的 name",
        ));
    }
    let canvas_ok = matches!(
        obj.get("canvas"),
        Some(Value::Object(c))
            if matches!(c.get("width"), Some(Value::Number(_)))
                && matches!(c.get("height"), Some(Value::Number(_)))
    );
    if !canvas_ok {
        return Err(CoMotionError::invalid(
            "project.json 格式錯誤：缺少或型別錯誤的 canvas",
        ));
    }
    let slides = match obj.get("slides") {
        Some(Value::Array(arr)) => arr,
        _ => {
            return Err(CoMotionError::invalid(
                "project.json 格式錯誤：slides 不是陣列",
            ));
        }
    };
    if !slides.iter().all(Value::is_string) {
        return Err(CoMotionError::invalid(
            "project.json 格式錯誤：slides 內含無效項目",
        ));
    }
    if let Some(fonts) = obj.get("fonts") {
        validate_fonts(fonts)?;
    }
    if let Some(templates) = obj.get("templates") {
        validate_templates(templates)?;
    }
    if let Some(transition) = obj.get("transition") {
        if !transition.is_string() {
            return Err(CoMotionError::invalid(
                "project.json 格式錯誤：transition 不是字串",
            ));
        }
    }

    Ok(obj)
}

const FONT_ENTRY_STRING_FIELDS: [&str; 5] = ["file", "family", "license", "licenseFile", "source"];

/// Structural + referential validation of the optional `fonts` field.
fn validate_fonts(value: &Value) -> CoMotionResult<()> {
    let arr = value
        .as_array()
        .ok_or_else(|| CoMotionError::invalid("project.json 格式錯誤：fonts 不是陣列"))?;
    let mut seen_families = std::collections::HashSet::new();
    for entry in arr {
        let obj = entry
            .as_object()
            .ok_or_else(|| CoMotionError::invalid("project.json 格式錯誤：fonts 內含無效項目"))?;
        for field in FONT_ENTRY_STRING_FIELDS {
            if !matches!(obj.get(field), Some(Value::String(_))) {
                return Err(CoMotionError::invalid(format!(
                    "project.json 格式錯誤：fonts 內的項目缺少或型別錯誤的 {field}"
                )));
            }
        }
        for path_field in ["file", "licenseFile"] {
            let path = obj
                .get(path_field)
                .and_then(Value::as_str)
                .expect("validated above");
            if path.starts_with('/') || path.split('/').any(|segment| segment == "..") {
                return Err(CoMotionError::invalid(
                    "project.json 格式錯誤：fonts 內含不合法的路徑",
                ));
            }
        }
        let family = obj
            .get("family")
            .and_then(Value::as_str)
            .expect("validated above")
            .to_string();
        if !seen_families.insert(family) {
            return Err(CoMotionError::invalid(
                "project.json 格式錯誤：fonts 內有重複的 family",
            ));
        }
    }
    Ok(())
}

/// Structural validation of the optional `templates` field. Accepts a
/// mixture of pre-upgrade bare-string entries and post-upgrade object
/// entries in the same array — the natural mid-upgrade state of a file only
/// some of whose writes have gone through normalization, not an error.
fn validate_templates(value: &Value) -> CoMotionResult<()> {
    let arr = value
        .as_array()
        .ok_or_else(|| CoMotionError::invalid("project.json 格式錯誤：templates 不是陣列"))?;
    for entry in arr {
        if entry.is_string() {
            continue;
        }
        let obj = entry.as_object().ok_or_else(|| {
            CoMotionError::invalid("project.json 格式錯誤：templates 內含無效項目")
        })?;
        let file = match obj.get("file") {
            Some(Value::String(s)) => s,
            _ => {
                return Err(CoMotionError::invalid(
                    "project.json 格式錯誤：templates 內的項目缺少或型別錯誤的 file",
                ));
            }
        };
        if !matches!(obj.get("name"), Some(Value::String(_))) {
            return Err(CoMotionError::invalid(
                "project.json 格式錯誤：templates 內的項目缺少或型別錯誤的 name",
            ));
        }
        if file.starts_with('/') || file.split('/').any(|segment| segment == "..") {
            return Err(CoMotionError::invalid(
                "project.json 格式錯誤：templates 內含不合法的路徑",
            ));
        }
    }
    Ok(())
}

/// The one entry point through which `templates` is ever read — normalizes
/// a pre-upgrade bare-string entry into `{ file, name }` with `name` falling
/// back to the file's basename minus a trailing `.svg` (never a blank name).
pub fn read_template_entries(project: &ProjectJson) -> Vec<TemplateEntry> {
    let templates = project
        .raw
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    templates
        .iter()
        .map(|entry| {
            if let Some(bare) = entry.as_str() {
                // `entry.split("/").pop() ?? entry` in TS: the last
                // segment, or the whole string when there is no "/".
                let base = bare.rsplit('/').next().unwrap_or(bare);
                let name = base.strip_suffix(".svg").unwrap_or(base).to_string();
                TemplateEntry {
                    file: bare.to_string(),
                    name,
                }
            } else {
                // Shape already confirmed by `validate_templates`.
                let obj = entry.as_object().expect("validated shape");
                TemplateEntry {
                    file: obj
                        .get("file")
                        .and_then(Value::as_str)
                        .expect("validated")
                        .to_string(),
                    name: obj
                        .get("name")
                        .and_then(Value::as_str)
                        .expect("validated")
                        .to_string(),
                }
            }
        })
        .collect()
}

/// Serializes `project.json`'s frozen write format: `serde_json`'s default
/// 2-space pretty printer plus exactly one trailing newline — matches
/// `` `${JSON.stringify(x, null, 2)}\n` ``. Key order is whatever `map`
/// iterates in (a `serde_json::Map` with the `preserve_order` feature is
/// insertion-ordered; `insert` on an existing key updates the value without
/// moving its position — matching JS object spread's own semantics for an
/// overridden existing key).
pub fn serialize_project_json(map: &serde_json::Map<String, Value>) -> String {
    let mut json = serde_json::to_string_pretty(map).expect("Value serialization cannot fail");
    json.push('\n');
    json
}

/// The one `project.json` write point every slide/template-mutating command
/// routes through (mirrors `slide-ops.ts`'s `writeProject`). `raw` must
/// already hold whatever field changes the caller wants (e.g. an updated
/// `slides` array) — this function's only jobs are bumping `formatVersion`
/// to the crate's current value and normalizing a present `templates` field
/// to the object-entry shape (`read_template_entries`'s same rule, applied
/// in place rather than requiring a full `ProjectJson`).
pub fn write_project(id: &str, mut raw: serde_json::Map<String, Value>) -> CoMotionResult<()> {
    raw.insert(
        "formatVersion".to_string(),
        Value::from(crate::presentation::FORMAT_VERSION),
    );
    if let Some(templates) = raw.get("templates").cloned() {
        raw.insert(
            "templates".to_string(),
            normalize_templates_value(&templates),
        );
    }
    let content = serialize_project_json(&raw);
    crate::workspace::write::write_presentation_file(id, "project.json", &content)
}

fn normalize_templates_value(templates: &Value) -> Value {
    let entries = templates.as_array().cloned().unwrap_or_default();
    let normalized: Vec<Value> = entries
        .iter()
        .map(|entry| {
            if let Some(bare) = entry.as_str() {
                let base = bare.rsplit('/').next().unwrap_or(bare);
                let name = base.strip_suffix(".svg").unwrap_or(base);
                serde_json::json!({ "file": bare, "name": name })
            } else {
                entry.clone()
            }
        })
        .collect();
    Value::Array(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-project-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_project_json(work_dir: &Path, contents: &str) {
        std::fs::write(work_dir.join("project.json"), contents).unwrap();
    }

    #[test]
    fn empty_slides_array_is_valid() {
        let work = temp_dir("empty-slides");
        write_project_json(
            &work,
            r#"{"formatVersion":1,"name":"Empty","canvas":{"width":1280,"height":720},"slides":[]}"#,
        );
        let project = read_project_json(&work).unwrap();
        assert!(project.slides.is_empty());
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn missing_required_field_reports_exact_field_message() {
        let work = temp_dir("missing-name");
        write_project_json(
            &work,
            r#"{"formatVersion":1,"canvas":{"width":1,"height":1},"slides":[]}"#,
        );
        let err = read_project_json(&work).unwrap_err();
        assert_eq!(
            err.message(),
            "project.json 格式錯誤：缺少或型別錯誤的 name"
        );
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn templates_mixing_bare_strings_and_objects_is_valid_and_normalizes() {
        let work = temp_dir("templates-mixed");
        write_project_json(
            &work,
            r#"{
                "formatVersion": 1,
                "name": "Mixed",
                "canvas": {"width": 1, "height": 1},
                "slides": [],
                "templates": ["templates/001.svg", {"file": "templates/002.svg", "name": "Custom"}]
            }"#,
        );
        let project = read_project_json(&work).unwrap();
        let entries = read_template_entries(&project);
        assert_eq!(
            entries,
            vec![
                TemplateEntry {
                    file: "templates/001.svg".to_string(),
                    name: "001".to_string()
                },
                TemplateEntry {
                    file: "templates/002.svg".to_string(),
                    name: "Custom".to_string()
                },
            ]
        );
        std::fs::remove_dir_all(&work).ok();
    }

    /// A float extra field, and its position relative to the known fields,
    /// must survive read -> re-serialize exactly — this is what a future
    /// write-back path would depend on, even though this ticket exposes no
    /// such path itself.
    #[test]
    fn round_trips_unknown_extra_field_and_float_value_exactly() {
        let work = temp_dir("extra-float");
        let source = r#"{"formatVersion":1,"name":"Extra","canvas":{"width":1,"height":1},"slides":[],"savedAt":1788887227268.932}"#;
        write_project_json(&work, source);

        let project = read_project_json(&work).unwrap();
        // Order preserved: the extra field is exactly where it was.
        let keys: Vec<&str> = project.raw.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec!["formatVersion", "name", "canvas", "slides", "savedAt"]
        );
        assert_eq!(
            project.raw.get("savedAt").and_then(Value::as_f64),
            Some(1788887227268.932_f64)
        );

        // Round-trip through serialize -> parse again: the float compares
        // exactly equal (serde_json's float formatting always produces the
        // shortest string that parses back to the same f64).
        let serialized = serde_json::to_string(&project.raw).unwrap();
        let reparsed: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reparsed["savedAt"].as_f64(), Some(1788887227268.932_f64));

        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn malformed_json_syntax_is_reported_as_corrupt() {
        let work = temp_dir("bad-syntax");
        write_project_json(&work, "{not valid json");
        let err = read_project_json(&work).unwrap_err();
        assert_eq!(err.message(), "簡報設定檔已損毀");
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn serialize_project_json_uses_two_space_indent_and_trailing_newline() {
        let mut map = serde_json::Map::new();
        map.insert("a".to_string(), Value::from(1));
        let json = serialize_project_json(&map);
        assert_eq!(json, "{\n  \"a\": 1\n}\n");
    }

    #[test]
    fn normalize_templates_value_upgrades_bare_strings_leaves_objects_alone() {
        let templates = serde_json::json!(["templates/001.svg", {"file": "templates/002.svg", "name": "Custom"}]);
        let normalized = normalize_templates_value(&templates);
        assert_eq!(
            normalized,
            serde_json::json!([
                {"file": "templates/001.svg", "name": "001"},
                {"file": "templates/002.svg", "name": "Custom"}
            ])
        );
    }
}
