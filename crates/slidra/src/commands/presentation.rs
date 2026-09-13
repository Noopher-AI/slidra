// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra presentation canvas set <presentation-id> --width <n> --height <n>`.

use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::workspace::project::read_project_json;
use crate::workspace::{self, virtual_fs, write as ws_write};
use crate::{argv, presentation_canvas};
use serde_json::Value;

pub fn run(args: &[String]) -> CommandResult {
    let sub = args.first().map(String::as_str);
    if sub != Some("canvas") {
        return CommandResult::failure(
            format!("unknown subcommand: presentation {}", sub.unwrap_or("")),
            FailureKind::Failed,
        );
    }
    let rest = &args[1..];
    let subsub = rest.first().map(String::as_str);
    if subsub != Some("set") {
        return CommandResult::failure(
            format!(
                "unknown subcommand: presentation canvas {}",
                subsub.unwrap_or("")
            ),
            FailureKind::Failed,
        );
    }
    let canvas_args = &rest[1..];

    let id = match argv::require_positional(
        canvas_args,
        0,
        "presentation canvas set",
        "presentation-id",
    ) {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let width = match argv::require_number_flag(canvas_args, "--width", "presentation canvas set") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let height = match argv::require_number_flag(canvas_args, "--height", "presentation canvas set")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };

    match set_presentation_canvas(&id, width, height) {
        Ok((w, h)) => CommandResult::success(
            format!(
                "set page size to {}×{}",
                crate::svgnum::format_svg_number(w),
                crate::svgnum::format_svg_number(h)
            ),
            // Whole-number integers in the `data` JSON (validated by
            // `assert_valid_canvas_dimension`), never `Value::from(f64)` —
            // see `set_presentation_canvas`'s own comment on the same trap.
            Some(serde_json::json!({ "width": w as i64, "height": h as i64 })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), FailureKind::Failed),
    }
}

/// Deliberately never occupies an undo step — every write goes through
/// `write_presentation_file_without_history`.
fn set_presentation_canvas(id: &str, width: f64, height: f64) -> Result<(f64, f64), SlidraError> {
    presentation_canvas::assert_valid_canvas_dimension(width, "width")?;
    presentation_canvas::assert_valid_canvas_dimension(height, "height")?;

    let work_dir = workspace::resolve_work_dir(id)?;
    let project = read_project_json(&work_dir)?;

    if project.canvas.width == width && project.canvas.height == height {
        return Ok((width, height));
    }

    let mut raw = project.raw.clone();
    let canvas = raw
        .get_mut("canvas")
        .and_then(Value::as_object_mut)
        .expect("validated canvas object");
    // `width`/`height` are already validated whole numbers
    // (`assert_valid_canvas_dimension`) — written as JSON integers, never
    // `Value::from(f64)`, which would serialize a whole-number float as
    // "1920.0" instead of "1920" (JS's `number` type has no such
    // distinction; `JSON.stringify` never adds a decimal point to an
    // integer-valued number).
    canvas.insert("width".to_string(), Value::from(width as i64));
    canvas.insert("height".to_string(), Value::from(height as i64));
    let content = crate::workspace::project::serialize_project_json(&raw);
    ws_write::write_presentation_file_without_history(id, "project.json", &content)?;

    for slide_path in &project.slides {
        let svg = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
        let updated = presentation_canvas::set_slide_view_box(&svg, slide_path, width, height)?;
        ws_write::write_presentation_file_without_history(id, slide_path, &updated)?;
    }

    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-canvas-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        id: String,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let guard = registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            let id = format!("test-{label}");
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            std::fs::create_dir_all(work.join("slides")).unwrap();
            std::fs::write(
                work.join("project.json"),
                r#"{"formatVersion":1,"name":"T","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"fonts":[]}"#,
            )
            .unwrap();
            std::fs::write(
                work.join("slides/001.svg"),
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>\n",
            )
            .unwrap();
            registry::register_for_test(&home, &id, &work);
            Fixture {
                home,
                work,
                id,
                _guard: guard,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    #[test]
    fn unknown_subcommand_fails() {
        let result = run(&["frobnicate".to_string()]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "unknown subcommand: presentation frobnicate"
        );
    }

    #[test]
    fn out_of_range_dimension_fails() {
        let fixture = Fixture::new("out-of-range");
        let result = run(&[
            "canvas".to_string(),
            "set".to_string(),
            fixture.id.clone(),
            "--width".to_string(),
            "10".to_string(),
            "--height".to_string(),
            "720".to_string(),
        ]);
        assert!(!result.ok);
        assert!(
            result
                .message
                .contains("must be an integer between 320 and 4096")
        );
    }

    #[test]
    fn same_size_is_a_legal_no_op_and_writes_nothing() {
        let fixture = Fixture::new("same-size");
        let before = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        let result = run(&[
            "canvas".to_string(),
            "set".to_string(),
            fixture.id.clone(),
            "--width".to_string(),
            "1280".to_string(),
            "--height".to_string(),
            "720".to_string(),
        ]);
        assert!(result.ok);
        let after = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn resizes_canvas_and_every_slide_without_occupying_undo() {
        let fixture = Fixture::new("resize");
        let result = run(&[
            "canvas".to_string(),
            "set".to_string(),
            fixture.id.clone(),
            "--width".to_string(),
            "1920".to_string(),
            "--height".to_string(),
            "1080".to_string(),
        ]);
        assert!(result.ok, "expected success, got {}", result.message);
        let project: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(project["canvas"]["width"], 1920);
        let slide = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert!(slide.contains("viewBox=\"0 0 1920 1080\""));

        let err = crate::history::undo(&fixture.id).unwrap_err();
        assert_eq!(err.message(), "no operation to undo");
    }
}
