//! The write half of workspace resolution: confirming a virtual path is one
//! of the presentation's declared slides/templates, and writing a
//! presentation file through the undo/redo staging API. Ported from the
//! relevant slices of `packages/core/src/workspace.ts`
//! (`assertSlidePathListed`, `writePresentationFile`) — this crate's first
//! content write path (`effect add`/`remove`/`move`/`set`, [E4.T7]), shared
//! infrastructure for every later write command (F3/F4/F5) too.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::history;
use crate::workspace::project::{ProjectJson, read_project_json, read_template_entries};
use std::path::Path;

/// Confirms `virtual_path` is one of the presentation's declared slides
/// (`project.json`'s `slides` array) or templates (ADR-0013 widening: a
/// template is edited with exactly the same element/effect commands a
/// slide is). Neither list is required to exist.
pub fn assert_slide_path_listed(
    work_dir: &Path,
    virtual_path: &str,
) -> CoMotionResult<ProjectJson> {
    let project = read_project_json(work_dir)?;
    let templates = read_template_entries(&project);
    let is_slide = project.slides.iter().any(|slide| slide == virtual_path);
    let is_template = templates
        .iter()
        .any(|template| template.file == virtual_path);
    if !is_slide && !is_template {
        return Err(CoMotionError::invalid(format!(
            "不是投影片：{virtual_path}"
        )));
    }
    Ok(project)
}

/// Writes `content` to `virtual_path` within presentation `id`, staging and
/// committing an undo-stack entry first — so the entry is durable before
/// the caller can observe the new content on disk. If the content write
/// itself then fails, the commit is unwound (`revert_committed_entries`): a
/// failed command must not occupy an undo slot, and it must not leave an
/// orphan snapshot file either.
pub fn write_presentation_file(id: &str, virtual_path: &str, content: &str) -> CoMotionResult<()> {
    let work_dir = crate::workspace::resolve_work_dir(id)?;
    let real_path =
        crate::workspace::virtual_fs::resolve_virtual_file_path(&work_dir, virtual_path)?;
    let entries = history::stage_snapshot_entries(id, &[virtual_path.to_string()])?;
    let commit = history::commit_snapshot_entries(id, entries.clone())?;
    match std::fs::write(&real_path, content) {
        Ok(()) => {
            history::finalize_committed_entries(id, &commit.pending_deletion_snapshot_ids)?;
            Ok(())
        }
        Err(_) => {
            history::revert_committed_entries(id, &entries, &commit.previous_stack)?;
            // real_path is a real filesystem path (ADR-0004) — never quote it.
            Err(CoMotionError::invalid(format!(
                "寫入投影片時發生錯誤：{virtual_path}"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-write-{label}-{}",
            id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_project_json(work_dir: &Path, slides: &[&str], templates: &[&str]) {
        let slides_json = serde_json::to_string(slides).unwrap();
        let templates_json = serde_json::to_string(templates).unwrap();
        let json = format!(
            r#"{{"formatVersion":1,"name":"Test","canvas":{{"width":1,"height":1}},"slides":{slides_json},"templates":{templates_json}}}"#
        );
        std::fs::write(work_dir.join("project.json"), json).unwrap();
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, test_id: &str, slides: &[&str], templates: &[&str]) -> Self {
            let guard = crate::workspace::registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            let work_dir_json =
                serde_json::to_string(&work.to_string_lossy().into_owned()).unwrap();
            let id_json = serde_json::to_string(test_id).unwrap();
            std::fs::write(
                home.join("projects.json"),
                format!(r#"{{{id_json}:{{"workDir":{work_dir_json}}}}}"#),
            )
            .unwrap();
            write_project_json(&work, slides, templates);
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }
            Fixture {
                home,
                work,
                _guard: guard,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    #[test]
    fn assert_slide_path_listed_accepts_a_declared_slide() {
        let fixture = Fixture::new("slide-ok", "pid-slide-ok", &["slides/001.svg"], &[]);
        assert_slide_path_listed(&fixture.work, "slides/001.svg").unwrap();
    }

    #[test]
    fn assert_slide_path_listed_accepts_a_declared_template() {
        let fixture = Fixture::new(
            "template-ok",
            "pid-template-ok",
            &[],
            &["templates/001.svg"],
        );
        assert_slide_path_listed(&fixture.work, "templates/001.svg").unwrap();
    }

    #[test]
    fn assert_slide_path_listed_rejects_an_unlisted_path() {
        let fixture = Fixture::new("unlisted", "pid-unlisted", &["slides/001.svg"], &[]);
        let err = assert_slide_path_listed(&fixture.work, "project.json").unwrap_err();
        assert_eq!(err.message(), "不是投影片：project.json");
    }

    #[test]
    fn write_presentation_file_updates_content_and_stages_undo() {
        let fixture = Fixture::new("write-ok", "pid-write-ok", &["slides/001.svg"], &[]);
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        std::fs::write(fixture.work.join("slides/001.svg"), b"<svg>BEFORE</svg>").unwrap();

        write_presentation_file("pid-write-ok", "slides/001.svg", "<svg>AFTER</svg>").unwrap();

        assert_eq!(
            std::fs::read(fixture.work.join("slides/001.svg")).unwrap(),
            b"<svg>AFTER</svg>"
        );

        let undo_result = history::undo("pid-write-ok").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(
            std::fs::read(fixture.work.join("slides/001.svg")).unwrap(),
            b"<svg>BEFORE</svg>"
        );
    }

    #[test]
    fn write_presentation_file_missing_real_file_is_not_found() {
        let _fixture = Fixture::new(
            "write-missing",
            "pid-write-missing",
            &["slides/001.svg"],
            &[],
        );
        let err = write_presentation_file("pid-write-missing", "slides/001.svg", "x").unwrap_err();
        assert!(matches!(err, CoMotionError::NotFound(_)));
    }
}
