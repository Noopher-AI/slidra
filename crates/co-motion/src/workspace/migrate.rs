//! `formatVersion` 1→2→3→4 migration, run once by `open` (via
//! `container::unpack_container`'s caller) on a freshly unpacked work
//! directory. Ported from `packages/core/src/project-migration.ts`'s
//! `migrateLegacyTransition` (the 2→3 step) plus two steps that TS never
//! had to implement standalone (1→2's `templates` upgrade — TS does this
//! lazily on next write instead; 3→4's `fonts` requirement — new to this
//! ticket, see plan §0's "對帳中最重要的一件事").
//!
//! `new` never calls this: it produces `formatVersion: 4` directly
//! (`presentation::build_minimal_presentation`).

use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::transition::{
    PageTransitionEffect, SlideTransition, SlideTransitionEdge, set_slide_transition,
    slide_has_transition_metadata,
};
use crate::svgnum::format_svg_number;
use crate::workspace::project::serialize_project_json;
use crate::workspace::virtual_fs;
use serde_json::Value;
use std::path::Path;

const LEGACY_FADE_ENTER_DURATION: f64 = 0.4;

/// Runs the 1→2→3→4 migration chain on `work_dir`'s `project.json`. Writes
/// the file back only when something actually needs to change —
/// `formatVersion == 4` is a byte-identical no-op. On any failure, `work_dir`
/// is removed entirely (no half-migrated work directory is ever left
/// behind) and the error propagated.
pub fn migrate_to_v4(work_dir: &Path) -> CoMotionResult<()> {
    match migrate_to_v4_inner(work_dir) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_dir_all(work_dir);
            Err(err)
        }
    }
}

fn migrate_to_v4_inner(work_dir: &Path) -> CoMotionResult<()> {
    let raw = virtual_fs::read_virtual_file(work_dir, "project.json")?;
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|_| CoMotionError::invalid("簡報設定檔已損毀"))?;
    crate::workspace::project::validate_project_json_value(&parsed)?;

    let format_version = parsed
        .get("formatVersion")
        .and_then(Value::as_f64)
        .expect("validate_project_json_value guarantees a numeric formatVersion");

    if format_version > 4.0 {
        return Err(CoMotionError::invalid(format!(
            "此簡報由較新版本的 CoMotion 建立（格式版本 {}），請升級後再開啟",
            format_svg_number(format_version)
        )));
    }
    if format_version == 4.0 {
        return Ok(());
    }

    let mut parsed = parsed;
    let obj = parsed.as_object_mut().expect("validated as object");

    // 1 -> 2: bare-string `templates` entries upgrade to `{ file, name }`.
    // A missing `templates` key is left missing, never added.
    if format_version < 2.0 {
        if let Some(templates) = obj.get("templates").cloned() {
            obj.insert("templates".to_string(), upgrade_templates(&templates));
        }
    }

    // 2 -> 3: a presentation-level `transition: "fade"` becomes each
    // slide-without-one's own `<comot:transition>`; every other value
    // (missing, "none", "", or an unknown string) is just dropped below,
    // with no per-slide write at all.
    if format_version < 3.0 {
        let is_fade = obj.get("transition").and_then(Value::as_str) == Some("fade");
        if is_fade {
            let slide_paths: Vec<String> = obj
                .get("slides")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            for slide_path in slide_paths {
                let svg = virtual_fs::read_virtual_file(work_dir, &slide_path)?;
                if slide_has_transition_metadata(&svg)? {
                    continue;
                }
                let updated = set_slide_transition(
                    &svg,
                    SlideTransition {
                        enter: SlideTransitionEdge {
                            effect: PageTransitionEffect::Fade,
                            duration: LEGACY_FADE_ENTER_DURATION,
                        },
                        exit: SlideTransitionEdge {
                            effect: PageTransitionEffect::None,
                            duration: 0.5,
                        },
                    },
                )?;
                let real_path = virtual_fs::resolve_virtual_file_path(work_dir, &slide_path)?;
                std::fs::write(&real_path, updated).map_err(|_| {
                    CoMotionError::invalid(format!("寫入投影片時發生錯誤：{slide_path}"))
                })?;
            }
        }
    }
    // Every version's migration ends with `transition` gone, whether or not
    // it was ever present.
    obj.remove("transition");

    // 3 -> 4: `fonts` becomes required; missing is filled with `[]` —
    // never a synthesized font item, never a copied font file (D4).
    if !obj.contains_key("fonts") {
        obj.insert("fonts".to_string(), Value::Array(Vec::new()));
    }

    // In place: `formatVersion` already exists in every valid file, so this
    // updates its value without moving its position.
    obj.insert("formatVersion".to_string(), Value::from(4u32));

    let content = serialize_project_json(obj);
    let real_path = virtual_fs::resolve_virtual_file_path(work_dir, "project.json")?;
    std::fs::write(&real_path, content)
        .map_err(|_| CoMotionError::invalid("寫入專案設定檔時發生錯誤"))?;
    Ok(())
}

fn upgrade_templates(templates: &Value) -> Value {
    let entries = templates.as_array().cloned().unwrap_or_default();
    let upgraded: Vec<Value> = entries
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
    Value::Array(upgraded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-migrate-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_project(work_dir: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(work_dir.join("project.json")).unwrap())
            .unwrap()
    }

    #[test]
    fn format_version_4_is_a_byte_identical_no_op() {
        let work = temp_dir("v4-noop");
        let original = r#"{"formatVersion":4,"name":"X","canvas":{"width":1,"height":1},"slides":[],"fonts":[]}"#;
        std::fs::write(work.join("project.json"), original).unwrap();
        migrate_to_v4(&work).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.join("project.json")).unwrap(),
            original
        );
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn format_version_too_new_errors_and_removes_work_dir() {
        let work = temp_dir("too-new");
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":5,"name":"X","canvas":{"width":1,"height":1},"slides":[]}"#,
        )
        .unwrap();
        let err = migrate_to_v4(&work).unwrap_err();
        assert!(err.message().contains("較新版本的 CoMotion"));
        assert!(!work.exists());
    }

    #[test]
    fn format_version_1_bumps_to_4_and_fills_missing_fonts() {
        let work = temp_dir("v1-basic");
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":1,"name":"X","canvas":{"width":1,"height":1},"slides":[]}"#,
        )
        .unwrap();
        migrate_to_v4(&work).unwrap();
        let project = read_project(&work);
        assert_eq!(project["formatVersion"], 4);
        assert_eq!(project["fonts"], serde_json::json!([]));
        assert!(project.get("transition").is_none());
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn format_version_1_upgrades_bare_string_templates() {
        let work = temp_dir("v1-templates");
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":1,"name":"X","canvas":{"width":1,"height":1},"slides":[],"templates":["templates/001.svg"]}"#,
        )
        .unwrap();
        migrate_to_v4(&work).unwrap();
        let project = read_project(&work);
        assert_eq!(
            project["templates"],
            serde_json::json!([{"file": "templates/001.svg", "name": "001"}])
        );
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn format_version_1_with_no_templates_key_does_not_add_one() {
        let work = temp_dir("v1-no-templates");
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":1,"name":"X","canvas":{"width":1,"height":1},"slides":[]}"#,
        )
        .unwrap();
        migrate_to_v4(&work).unwrap();
        let project = read_project(&work);
        assert!(project.get("templates").is_none());
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn transition_fade_writes_enter_fade_on_slides_without_one() {
        let work = temp_dir("fade-migration");
        std::fs::create_dir_all(work.join("slides")).unwrap();
        std::fs::write(
            work.join("slides/001.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>\n",
        )
        .unwrap();
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":2,"name":"X","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"transition":"fade"}"#,
        )
        .unwrap();
        migrate_to_v4(&work).unwrap();
        let slide = std::fs::read_to_string(work.join("slides/001.svg")).unwrap();
        assert!(
            slide.contains(
                "enter=\"fade\" enter-duration=\"0.4\" exit=\"none\" exit-duration=\"0.5\""
            )
        );
        let project = read_project(&work);
        assert!(project.get("transition").is_none());
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn transition_fade_skips_slide_that_already_has_transition_metadata() {
        let work = temp_dir("fade-skip-existing");
        std::fs::create_dir_all(work.join("slides")).unwrap();
        let existing_slide = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><comot:transition xmlns:comot=\"https://co-motion.dev/ns\" enter=\"zoom\" enter-duration=\"1\" exit=\"none\" exit-duration=\"0.5\"/></metadata></svg>\n";
        std::fs::write(work.join("slides/001.svg"), existing_slide).unwrap();
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":2,"name":"X","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"transition":"fade"}"#,
        )
        .unwrap();
        migrate_to_v4(&work).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.join("slides/001.svg")).unwrap(),
            existing_slide
        );
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn transition_none_only_drops_the_key_no_slide_writes() {
        let work = temp_dir("transition-none");
        std::fs::create_dir_all(work.join("slides")).unwrap();
        let slide = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>\n";
        std::fs::write(work.join("slides/001.svg"), slide).unwrap();
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":2,"name":"X","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"transition":"none"}"#,
        )
        .unwrap();
        migrate_to_v4(&work).unwrap();
        assert_eq!(
            std::fs::read_to_string(work.join("slides/001.svg")).unwrap(),
            slide
        );
        let project = read_project(&work);
        assert!(project.get("transition").is_none());
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn unknown_extra_field_and_key_order_survive_migration() {
        let work = temp_dir("extra-field-order");
        std::fs::write(
            work.join("project.json"),
            r#"{"formatVersion":1,"name":"X","canvas":{"width":1,"height":1},"slides":[],"mystery":42}"#,
        )
        .unwrap();
        migrate_to_v4(&work).unwrap();
        let text = std::fs::read_to_string(work.join("project.json")).unwrap();
        let project: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(project["mystery"], 42);
        let keys: Vec<&str> = project
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "formatVersion",
                "name",
                "canvas",
                "slides",
                "mystery",
                "fonts"
            ]
        );
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn malformed_project_json_removes_work_dir() {
        let work = temp_dir("malformed");
        std::fs::write(work.join("project.json"), "{not valid json").unwrap();
        let err = migrate_to_v4(&work).unwrap_err();
        assert_eq!(err.message(), "簡報設定檔已損毀");
        assert!(!work.exists());
    }
}
