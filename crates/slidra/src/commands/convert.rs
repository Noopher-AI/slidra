// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra convert <presentation-id>`. Every slide is read and
//! normalised BEFORE anything is written, so one unconvertible slide aborts
//! the run with not a single byte written; the write loop rolls already-
//! written slides back if a later write fails. Never goes through
//! `workspace::write` (does not occupy an undo step).

use crate::errors::{SlidraError, SlidraResult};
use crate::result::{CommandResult, FailureKind};
use crate::slide::normalise::normalise_slide_svg;
use crate::workspace::{self, project::read_project_json, virtual_fs};
use crate::{argv, id};

/// Writes `slide_path`'s content into `deck_path`, mapping any failure to
/// the same "error writing slide: …" wording the pre-SQLite version used
/// (`std::fs::write` failing on a real path) — the write itself now goes
/// through `virtual_fs::write_existing_file` instead of a raw filesystem
/// call, but the caller-visible contract is unchanged.
fn write_slide(deck_path: &std::path::Path, slide_path: &str, content: &str) -> bool {
    virtual_fs::write_existing_file(deck_path, slide_path, content.as_bytes()).is_ok()
}

pub fn run(args: &[String]) -> CommandResult {
    let presentation_id = match argv::require_id_positional(args, 0, "convert", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match convert_presentation_slides(&presentation_id) {
        Ok(outcomes) => {
            let changed = outcomes.iter().filter(|o| o.changed).count();
            let untouched = outcomes.len() - changed;
            let data = serde_json::json!({
                "slides": outcomes.iter().map(|o| serde_json::json!({
                    "slidePath": o.slide_path,
                    "changed": o.changed,
                    "wrapped": o.wrapped,
                })).collect::<Vec<_>>(),
            });
            CommandResult::success(describe(changed, untouched), Some(data))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn describe(changed: usize, untouched: usize) -> String {
    if changed == 0 && untouched == 0 {
        return "no slides need converting".to_string();
    }
    if untouched == 0 {
        return format!("converted {changed} slides");
    }
    format!("converted {changed} slides, {untouched} already compliant")
}

struct SlideOutcome {
    slide_path: String,
    changed: bool,
    wrapped: usize,
}

struct PendingSlide {
    slide_path: String,
    svg: String,
    original: String,
    wrapped: usize,
}

fn convert_presentation_slides(id_str: &str) -> SlidraResult<Vec<SlideOutcome>> {
    let work_dir = workspace::resolve_work_dir(id_str)?;
    let project = read_project_json(&work_dir)?;

    let mut pending: Vec<PendingSlide> = Vec::with_capacity(project.slides.len());
    for slide_path in &project.slides {
        let original = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
        let mut generate_id = || format!("el-{}", id::generate_opaque_id());
        let result = normalise_slide_svg(&original, &mut generate_id).map_err(|err| {
            SlidraError::invalid(format!(
                "{slide_path}: {}the entire presentation was not modified.",
                err.message()
            ))
        })?;
        pending.push(PendingSlide {
            slide_path: slide_path.clone(),
            svg: result.svg,
            original,
            wrapped: result.wrapped,
        });
    }

    let mut outcomes = Vec::with_capacity(pending.len());
    let mut written: Vec<&PendingSlide> = Vec::new();
    for slide in &pending {
        let changed = slide.svg != slide.original;
        if changed {
            if !write_slide(&work_dir, &slide.slide_path, &slide.svg) {
                return Err(SlidraError::invalid(roll_back(&work_dir, &written, slide)));
            }
            written.push(slide);
        }
        outcomes.push(SlideOutcome {
            slide_path: slide.slide_path.clone(),
            changed,
            wrapped: slide.wrapped,
        });
    }
    Ok(outcomes)
}

/// Puts back every slide this run had already rewritten before one of them
/// failed to write, and returns the message describing what actually
/// happened on disk.
fn roll_back(
    work_dir: &std::path::Path,
    written: &[&PendingSlide],
    failed: &PendingSlide,
) -> String {
    let mut not_restored: Vec<String> = Vec::new();
    for slide in written {
        if !write_slide(work_dir, &slide.slide_path, &slide.original) {
            not_restored.push(slide.slide_path.clone());
        }
    }
    if !restored_to_original(work_dir, failed) {
        not_restored.push(failed.slide_path.clone());
    }
    let failure = format!("error writing slide: {}.", failed.slide_path);
    if not_restored.is_empty() {
        return format!("{failure}the entire presentation was not modified.");
    }
    format!(
        "{failure}restoring the already-rewritten slides failed, these slides are no longer original content, the rest remain unchanged: {}. Fix the disk issue and re-run convert.",
        not_restored.join(", ")
    )
}

fn restored_to_original(work_dir: &std::path::Path, slide: &PendingSlide) -> bool {
    let current = match virtual_fs::read_virtual_file(work_dir, &slide.slide_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    if current == slide.original {
        return true;
    }
    write_slide(work_dir, &slide.slide_path, &slide.original)
}

fn failure_kind_for(err: &SlidraError) -> FailureKind {
    match err {
        SlidraError::NotFound(_) => FailureKind::NotFound,
        SlidraError::InvalidRequest(_) => FailureKind::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-convert-{label}-{}",
            id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fixture {
        home: PathBuf,
        deck: PathBuf,
        id: String,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, project_json: &str, slides: &[(&str, &str)]) -> Self {
            let guard = registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let test_id = format!("test-{label}");
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            let mut files: Vec<(&str, &[u8])> = vec![("project.json", project_json.as_bytes())];
            for (path, content) in slides {
                files.push((path, content.as_bytes()));
            }
            let deck = crate::deck::build_test_deck(label, &files);
            registry::register_for_test(&home, &test_id, &deck);
            Fixture {
                home,
                deck,
                id: test_id,
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
            std::fs::remove_file(&self.deck).ok();
        }
    }

    #[test]
    fn missing_id_argument_fails() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command convert missing argument: presentation-id"
        );
    }

    #[test]
    fn already_compliant_slide_reports_no_slides_need_conversion_when_empty() {
        let fixture = Fixture::new(
            "empty",
            r#"{"formatVersion":5,"name":"T","canvas":{"width":100,"height":100},"slides":[],"fonts":[]}"#,
            &[],
        );
        let result = run(&[fixture.id.clone()]);
        assert!(result.ok);
        assert_eq!(result.message, "no slides need converting");
    }

    #[test]
    fn wraps_a_bare_primitive_and_reports_changed() {
        let fixture = Fixture::new(
            "wrap",
            r#"{"formatVersion":5,"name":"T","canvas":{"width":100,"height":100},"slides":["slides/001.svg"],"fonts":[]}"#,
            &[(
                "slides/001.svg",
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">\n  <rect width=\"1\" height=\"1\"/>\n</svg>",
            )],
        );
        let result = run(&[fixture.id.clone()]);
        assert!(result.ok);
        assert_eq!(result.message, "converted 1 slides");
        let content =
            crate::workspace::virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg")
                .unwrap();
        assert!(content.contains("<g id="));
    }

    #[test]
    fn already_compliant_slide_is_untouched_and_reported_as_such() {
        let fixture = Fixture::new(
            "compliant",
            r#"{"formatVersion":5,"name":"T","canvas":{"width":100,"height":100},"slides":["slides/001.svg"],"fonts":[]}"#,
            &[(
                "slides/001.svg",
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g id=\"a\"><rect width=\"1\" height=\"1\"/></g></svg>",
            )],
        );
        let before =
            crate::workspace::virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg")
                .unwrap();
        let result = run(&[fixture.id.clone()]);
        assert!(result.ok);
        assert_eq!(result.message, "converted 0 slides, 1 already compliant");
        let after =
            crate::workspace::virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg")
                .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn blocking_issue_writes_nothing_and_names_the_slide() {
        let fixture = Fixture::new(
            "blocking",
            r#"{"formatVersion":5,"name":"T","canvas":{"width":100,"height":100},"slides":["slides/001.svg"],"fonts":[]}"#,
            &[(
                "slides/001.svg",
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><script>evil()</script></svg>",
            )],
        );
        let before =
            crate::workspace::virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg")
                .unwrap();
        let result = run(&[fixture.id.clone()]);
        assert!(!result.ok);
        assert!(result.message.starts_with("slides/001.svg: "));
        assert!(
            result
                .message
                .ends_with("the entire presentation was not modified.")
        );
        let after =
            crate::workspace::virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg")
                .unwrap();
        assert_eq!(before, after);
    }
}
