// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Reading and structurally validating `project.json`. Ported from
//! `packages/core/src/project-json.ts` (full file) plus the read-only half
//! of `packages/core/src/workspace.ts`'s internal `readProjectJson`.
//!
//! Public API:
//! - `read_project_json(work_dir) -> SlidraResult<ProjectJson>` — reads
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

use crate::errors::{SlidraError, SlidraResult};
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
/// failure ("presentation config file is corrupted" — that function never ran
/// `validateProjectJson` at all), then additionally runs the full
/// `validateProjectJson` structural check so a caller here gets the same
/// field-precise errors `open`/`serve` do in TS, not just "this happens to
/// have a `slides` array."
pub fn read_project_json(work_dir: &Path) -> SlidraResult<ProjectJson> {
    let text = virtual_fs::read_virtual_file(work_dir, "project.json")?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| SlidraError::invalid("presentation config file is corrupted"))?;
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
pub fn validate_project_json_value(value: &Value) -> SlidraResult<()> {
    validate_project_json(value)?;
    Ok(())
}

/// Structural validation of an already-JSON-parsed `project.json`, ported
/// from `validateProjectJson`. An empty `slides` array is structurally
/// valid. Unknown extra fields are accepted, never rejected (forward
/// compatibility, ADR-0003). Never includes a filesystem path (ADR-0004).
fn validate_project_json(value: &Value) -> SlidraResult<&serde_json::Map<String, Value>> {
    // `Value::as_object()` returns `None` for a JSON array too (arrays and
    // objects are distinct `Value` variants here, unlike JS where
    // `typeof [] === "object"`), so this one check also covers the TS
    // original's separate `Array.isArray(value)` branch.
    let obj = value.as_object().ok_or_else(|| {
        SlidraError::invalid("project.json format error: content is not an object")
    })?;

    let format_version_ok = matches!(
        obj.get("formatVersion"),
        Some(Value::Number(n)) if n.as_u64() == Some(u64::from(crate::presentation::FORMAT_VERSION))
    );
    if !format_version_ok {
        return Err(SlidraError::invalid(format!(
            "project.json format error: formatVersion must be {}",
            crate::presentation::FORMAT_VERSION
        )));
    }
    if !matches!(obj.get("name"), Some(Value::String(_))) {
        return Err(SlidraError::invalid(
            "project.json format error: missing or wrong type for name",
        ));
    }
    let canvas_ok = matches!(
        obj.get("canvas"),
        Some(Value::Object(c))
            if matches!(c.get("width"), Some(Value::Number(_)))
                && matches!(c.get("height"), Some(Value::Number(_)))
    );
    if !canvas_ok {
        return Err(SlidraError::invalid(
            "project.json format error: missing or wrong type for canvas",
        ));
    }
    let slides = match obj.get("slides") {
        Some(Value::Array(arr)) => arr,
        _ => {
            return Err(SlidraError::invalid(
                "project.json format error: slides is not an array",
            ));
        }
    };
    if !slides.iter().all(Value::is_string) {
        return Err(SlidraError::invalid(
            "project.json format error: slides contains an invalid item",
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
            return Err(SlidraError::invalid(
                "project.json format error: transition is not a string",
            ));
        }
    }

    Ok(obj)
}

const FONT_ENTRY_STRING_FIELDS: [&str; 5] = ["file", "family", "license", "licenseFile", "source"];

/// Structural + referential validation of the optional `fonts` field.
fn validate_fonts(value: &Value) -> SlidraResult<()> {
    let arr = value
        .as_array()
        .ok_or_else(|| SlidraError::invalid("project.json format error: fonts is not an array"))?;
    let mut seen_families = std::collections::HashSet::new();
    for entry in arr {
        let obj = entry.as_object().ok_or_else(|| {
            SlidraError::invalid("project.json format error: fonts contains an invalid item")
        })?;
        for field in FONT_ENTRY_STRING_FIELDS {
            if !matches!(obj.get(field), Some(Value::String(_))) {
                return Err(SlidraError::invalid(format!(
                    "project.json format error: fonts item missing or wrong type for {field}"
                )));
            }
        }
        for path_field in ["file", "licenseFile"] {
            let path = obj
                .get(path_field)
                .and_then(Value::as_str)
                .expect("validated above");
            if path.starts_with('/') || path.split('/').any(|segment| segment == "..") {
                return Err(SlidraError::invalid(
                    "project.json format error: fonts contains an invalid path",
                ));
            }
        }
        let family = obj
            .get("family")
            .and_then(Value::as_str)
            .expect("validated above")
            .to_string();
        if !seen_families.insert(family) {
            return Err(SlidraError::invalid(
                "project.json format error: fonts has a duplicate family",
            ));
        }
    }
    Ok(())
}

/// Structural validation of the optional `templates` field. Accepts a
/// mixture of pre-upgrade bare-string entries and post-upgrade object
/// entries in the same array — the natural mid-upgrade state of a file only
/// some of whose writes have gone through normalization, not an error.
fn validate_templates(value: &Value) -> SlidraResult<()> {
    let arr = value.as_array().ok_or_else(|| {
        SlidraError::invalid("project.json format error: templates is not an array")
    })?;
    for entry in arr {
        if entry.is_string() {
            continue;
        }
        let obj = entry.as_object().ok_or_else(|| {
            SlidraError::invalid("project.json format error: templates contains an invalid item")
        })?;
        let file = match obj.get("file") {
            Some(Value::String(s)) => s,
            _ => {
                return Err(SlidraError::invalid(
                    "project.json format error: templates item missing or wrong type for file",
                ));
            }
        };
        if !matches!(obj.get("name"), Some(Value::String(_))) {
            return Err(SlidraError::invalid(
                "project.json format error: templates item missing or wrong type for name",
            ));
        }
        if file.starts_with('/') || file.split('/').any(|segment| segment == "..") {
            return Err(SlidraError::invalid(
                "project.json format error: templates contains an invalid path",
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
/// to the crate's current value, normalizing a present `templates` field to
/// the object-entry shape (`read_template_entries`'s same rule, applied in
/// place rather than requiring a full `ProjectJson`), and defaulting a
/// missing `fonts` key to `[]` (`docs/spec/slidra-format.md`: `fonts` is
/// required — as a key, not a non-empty value — from format v4 on; TS's own
/// `writeProject` in `packages/core/src/slide-ops.ts` applies the same
/// default). Only the key's PRESENCE is checked (`contains_key`, not
/// whether the existing value is well-formed) — a malformed `fonts` value
/// is a `validate_project_json` read-time concern, not something this write
/// path repairs.
pub fn write_project(id: &str, mut raw: serde_json::Map<String, Value>) -> SlidraResult<()> {
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
    if !raw.contains_key("fonts") {
        raw.insert("fonts".to_string(), Value::Array(Vec::new()));
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

    fn deck_with_project_json(label: &str, contents: &str) -> std::path::PathBuf {
        crate::deck::build_test_deck(label, &[("project.json", contents.as_bytes())])
    }

    #[test]
    fn empty_slides_array_is_valid() {
        let deck = deck_with_project_json(
            "empty-slides",
            r#"{"formatVersion":5,"name":"Empty","canvas":{"width":1280,"height":720},"slides":[]}"#,
        );
        let project = read_project_json(&deck).unwrap();
        assert!(project.slides.is_empty());
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn missing_required_field_reports_exact_field_message() {
        let deck = deck_with_project_json(
            "missing-name",
            r#"{"formatVersion":5,"canvas":{"width":1,"height":1},"slides":[]}"#,
        );
        let err = read_project_json(&deck).unwrap_err();
        assert_eq!(
            err.message(),
            "project.json format error: missing or wrong type for name"
        );
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn templates_mixing_bare_strings_and_objects_is_valid_and_normalizes() {
        let deck = deck_with_project_json(
            "templates-mixed",
            r#"{
                "formatVersion": 5,
                "name": "Mixed",
                "canvas": {"width": 1, "height": 1},
                "slides": [],
                "templates": ["templates/001.svg", {"file": "templates/002.svg", "name": "Custom"}]
            }"#,
        );
        let project = read_project_json(&deck).unwrap();
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
        std::fs::remove_file(&deck).ok();
    }

    /// A float extra field, and its position relative to the known fields,
    /// must survive read -> re-serialize exactly — this is what a future
    /// write-back path would depend on, even though this ticket exposes no
    /// such path itself.
    #[test]
    fn round_trips_unknown_extra_field_and_float_value_exactly() {
        let source = r#"{"formatVersion":5,"name":"Extra","canvas":{"width":1,"height":1},"slides":[],"savedAt":1788887227268.932}"#;
        let deck = deck_with_project_json("extra-float", source);

        let project = read_project_json(&deck).unwrap();
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

        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn malformed_json_syntax_is_reported_as_corrupt() {
        let deck = deck_with_project_json("bad-syntax", "{not valid json");
        let err = read_project_json(&deck).unwrap_err();
        assert_eq!(err.message(), "presentation config file is corrupted");
        std::fs::remove_file(&deck).ok();
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

    struct WriteProjectFixture {
        home: std::path::PathBuf,
        deck: std::path::PathBuf,
        id: String,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl WriteProjectFixture {
        fn new(label: &str) -> Self {
            let guard = crate::workspace::registry::ENV_LOCK.lock().unwrap();
            let home = std::env::temp_dir().join(format!(
                "slidra-test-project-write-{label}-home-{}",
                crate::id::random_hex_suffix()
            ));
            std::fs::create_dir_all(&home).unwrap();
            let id = format!("test-write-project-{label}");
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            // A placeholder that write_project's history staging reads as
            // the "before" snapshot — its content is irrelevant, only its
            // presence is (`history::stage_snapshot_entries` reads the
            // existing virtual file before write_project's own content
            // replaces it).
            let deck = crate::deck::build_test_deck(label, &[("project.json", b"{}")]);
            crate::workspace::registry::register_for_test(&home, &id, &deck);
            WriteProjectFixture {
                home,
                deck,
                id,
                _guard: guard,
            }
        }
    }

    impl Drop for WriteProjectFixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_file(&self.deck).ok();
        }
    }

    /// FAIL 2 (NOOP-334r2): `write_project` is Rust's only `project.json`
    /// write point, and it did not default a missing `fonts` key the way
    /// TS's `writeProject` (`packages/core/src/slide-ops.ts`) does —
    /// `docs/spec/slidra-format.md` requires the key to always be present.
    /// Asserts the FULL serialized bytes, not just "contains fonts": the
    /// key's position (after every existing key, matching TS's
    /// `nextProject.fonts = []` appending onto an object with no such key)
    /// is exactly what made two engines' `project.json` diverge byte-wise
    /// (`e2e/page-management.test.ts`'s cross-engine equality check).
    #[test]
    fn write_project_defaults_a_missing_fonts_key_to_an_empty_array() {
        let fixture = WriteProjectFixture::new("missing-fonts");
        let mut raw = serde_json::Map::new();
        raw.insert("formatVersion".to_string(), Value::from(1));
        raw.insert("name".to_string(), Value::from("T"));
        raw.insert(
            "canvas".to_string(),
            serde_json::json!({"width": 1, "height": 1}),
        );
        raw.insert("slides".to_string(), Value::Array(Vec::new()));

        write_project(&fixture.id, raw).unwrap();

        let content =
            crate::workspace::virtual_fs::read_virtual_file(&fixture.deck, "project.json").unwrap();
        assert_eq!(
            content,
            "{\n  \"formatVersion\": 5,\n  \"name\": \"T\",\n  \"canvas\": {\n    \"width\": 1,\n    \"height\": 1\n  },\n  \"slides\": [],\n  \"fonts\": []\n}\n"
        );
    }

    /// The other half of the same contract: an already-present `fonts`
    /// value — populated or not — must survive untouched, in its original
    /// position, never synthesized over or moved.
    #[test]
    fn write_project_leaves_an_existing_fonts_value_untouched_in_place() {
        let fixture = WriteProjectFixture::new("existing-fonts");
        let mut raw = serde_json::Map::new();
        raw.insert("formatVersion".to_string(), Value::from(1));
        raw.insert("name".to_string(), Value::from("T"));
        raw.insert(
            "fonts".to_string(),
            serde_json::json!([{"family": "Inter", "file": "fonts/inter.ttf"}]),
        );
        raw.insert("slides".to_string(), Value::Array(Vec::new()));

        write_project(&fixture.id, raw).unwrap();

        let content =
            crate::workspace::virtual_fs::read_virtual_file(&fixture.deck, "project.json").unwrap();
        assert_eq!(
            content,
            "{\n  \"formatVersion\": 5,\n  \"name\": \"T\",\n  \"fonts\": [\n    {\n      \"family\": \"Inter\",\n      \"file\": \"fonts/inter.ttf\"\n    }\n  ],\n  \"slides\": []\n}\n"
        );
    }
}
