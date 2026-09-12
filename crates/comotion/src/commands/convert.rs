//! `comotion convert <presentation-id>`, ported from
//! `packages/cli/src/commands/convert.ts`. Every slide is read and
//! normalised BEFORE anything is written, so one unconvertible slide aborts
//! the run with not a single byte written; the write loop rolls already-
//! written slides back if a later write fails. Never goes through
//! `workspace::write` (does not occupy an undo step — TS writes directly,
//! and this ports that exactly).

use crate::errors::{CoMotionError, CoMotionResult};
use crate::result::{CommandResult, FailureKind};
use crate::slide::normalise::normalise_slide_svg;
use crate::workspace::{self, project::read_project_json, virtual_fs};
use crate::{argv, id};
use std::path::PathBuf;

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
        return "沒有投影片需要轉換".to_string();
    }
    if untouched == 0 {
        return format!("已轉換 {changed} 張投影片");
    }
    format!("已轉換 {changed} 張投影片，{untouched} 張原本就合規")
}

struct SlideOutcome {
    slide_path: String,
    changed: bool,
    wrapped: usize,
}

struct PendingSlide {
    slide_path: String,
    real_path: PathBuf,
    svg: String,
    original: String,
    wrapped: usize,
}

fn convert_presentation_slides(id_str: &str) -> CoMotionResult<Vec<SlideOutcome>> {
    let work_dir = workspace::resolve_work_dir(id_str)?;
    let project = read_project_json(&work_dir)?;

    let mut pending: Vec<PendingSlide> = Vec::with_capacity(project.slides.len());
    for slide_path in &project.slides {
        let original = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
        let real_path = virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
        let mut generate_id = || format!("el-{}", id::generate_opaque_id());
        let result = normalise_slide_svg(&original, &mut generate_id).map_err(|err| {
            CoMotionError::invalid(format!(
                "{slide_path}：{}整份簡報都沒有被修改。",
                err.message()
            ))
        })?;
        pending.push(PendingSlide {
            slide_path: slide_path.clone(),
            real_path,
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
            if std::fs::write(&slide.real_path, &slide.svg).is_err() {
                return Err(CoMotionError::invalid(roll_back(&written, slide)));
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
fn roll_back(written: &[&PendingSlide], failed: &PendingSlide) -> String {
    let mut not_restored: Vec<String> = Vec::new();
    for slide in written {
        if std::fs::write(&slide.real_path, &slide.original).is_err() {
            not_restored.push(slide.slide_path.clone());
        }
    }
    if !restored_to_original(failed) {
        not_restored.push(failed.slide_path.clone());
    }
    let failure = format!("寫入投影片時發生錯誤：{}。", failed.slide_path);
    if not_restored.is_empty() {
        return format!("{failure}整份簡報都沒有被修改。");
    }
    format!(
        "{failure}已改寫的投影片還原失敗，這幾張現在不是原始內容，其餘維持原樣：{}。請修復磁碟問題後重新執行 convert。",
        not_restored.join("、")
    )
}

fn restored_to_original(slide: &PendingSlide) -> bool {
    let current = match std::fs::read_to_string(&slide.real_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    if current == slide.original {
        return true;
    }
    std::fs::write(&slide.real_path, &slide.original).is_ok()
}

fn failure_kind_for(err: &CoMotionError) -> FailureKind {
    match err {
        CoMotionError::NotFound(_) => FailureKind::NotFound,
        CoMotionError::InvalidRequest(_) => FailureKind::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "comotion-test-convert-{label}-{}",
            id::random_hex_suffix()
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
        fn new(label: &str, project_json: &str, slides: &[(&str, &str)]) -> Self {
            let guard = registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            let test_id = format!("test-{label}");
            unsafe {
                std::env::set_var("COMOTION_HOME", &home);
            }
            std::fs::create_dir_all(work.join("slides")).unwrap();
            std::fs::write(work.join("project.json"), project_json).unwrap();
            for (path, content) in slides {
                std::fs::write(work.join(path), content).unwrap();
            }
            registry::register_for_test(&home, &test_id, &work);
            Fixture {
                home,
                work,
                id: test_id,
                _guard: guard,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("COMOTION_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    #[test]
    fn missing_id_argument_fails() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 convert 缺少參數：presentation-id");
    }

    #[test]
    fn already_compliant_slide_reports_no_slides_need_conversion_when_empty() {
        let fixture = Fixture::new(
            "empty",
            r#"{"formatVersion":1,"name":"T","canvas":{"width":100,"height":100},"slides":[],"fonts":[]}"#,
            &[],
        );
        let result = run(&[fixture.id.clone()]);
        assert!(result.ok);
        assert_eq!(result.message, "沒有投影片需要轉換");
    }

    #[test]
    fn wraps_a_bare_primitive_and_reports_changed() {
        let fixture = Fixture::new(
            "wrap",
            r#"{"formatVersion":1,"name":"T","canvas":{"width":100,"height":100},"slides":["slides/001.svg"],"fonts":[]}"#,
            &[(
                "slides/001.svg",
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\">\n  <rect width=\"1\" height=\"1\"/>\n</svg>",
            )],
        );
        let result = run(&[fixture.id.clone()]);
        assert!(result.ok);
        assert_eq!(result.message, "已轉換 1 張投影片");
        let content = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert!(content.contains("<g id="));
    }

    #[test]
    fn already_compliant_slide_is_untouched_and_reported_as_such() {
        let fixture = Fixture::new(
            "compliant",
            r#"{"formatVersion":1,"name":"T","canvas":{"width":100,"height":100},"slides":["slides/001.svg"],"fonts":[]}"#,
            &[(
                "slides/001.svg",
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><g id=\"a\"><rect width=\"1\" height=\"1\"/></g></svg>",
            )],
        );
        let before = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        let result = run(&[fixture.id.clone()]);
        assert!(result.ok);
        assert_eq!(result.message, "已轉換 0 張投影片，1 張原本就合規");
        let after = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn blocking_issue_writes_nothing_and_names_the_slide() {
        let fixture = Fixture::new(
            "blocking",
            r#"{"formatVersion":1,"name":"T","canvas":{"width":100,"height":100},"slides":["slides/001.svg"],"fonts":[]}"#,
            &[(
                "slides/001.svg",
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><script>evil()</script></svg>",
            )],
        );
        let before = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        let result = run(&[fixture.id.clone()]);
        assert!(!result.ok);
        assert!(result.message.starts_with("slides/001.svg："));
        assert!(result.message.ends_with("整份簡報都沒有被修改。"));
        let after = std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap();
        assert_eq!(before, after);
    }
}
