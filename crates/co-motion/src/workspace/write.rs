//! Content-write doors, ported from `packages/core/src/workspace.ts` lines
//! 549-603 and 1095-1157: `write_presentation_file`/
//! `write_presentation_file_without_history`/`create_presentation_file`/
//! `delete_presentation_file`. Every content-writing command in this crate
//! routes through one of these, so undo/redo is free (`history.rs`'s
//! staging API) without each command writing its own inverse logic.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::history;
use crate::workspace::{self, virtual_fs};

/// The single door every content-writing command must use. Snapshots the
/// file's current content into undo history (committed durable) BEFORE the
/// content write itself — so nothing makes the new content visible until
/// the undo group that reverts it is already durable. If the content write
/// then fails, the commit is unwound.
pub fn write_presentation_file(id: &str, virtual_path: &str, content: &str) -> CoMotionResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let real_path = virtual_fs::resolve_virtual_file_path(&work_dir, virtual_path)?;
    let entries = history::stage_snapshot_entries(id, &[virtual_path.to_string()])?;
    let commit = history::commit_snapshot_entries(id, entries.clone())?;
    match std::fs::write(&real_path, content) {
        Ok(()) => {
            history::finalize_committed_entries(id, &commit.pending_deletion_snapshot_ids)?;
            Ok(())
        }
        Err(_) => {
            history::revert_committed_entries(id, &entries, commit.previous_stack)?;
            // real_path is a real filesystem path (ADR-0004) — never quote it.
            Err(CoMotionError::invalid(format!(
                "寫入投影片時發生錯誤：{virtual_path}"
            )))
        }
    }
}

/// The one exception door: only `presentation canvas set` uses this — page
/// size never occupies an undo step. No snapshot/commit bracket at all, so
/// nothing is pushed onto the undo stack.
pub fn write_presentation_file_without_history(
    id: &str,
    virtual_path: &str,
    content: &str,
) -> CoMotionResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let real_path = virtual_fs::resolve_virtual_file_path(&work_dir, virtual_path)?;
    std::fs::write(&real_path, content)
        .map_err(|_| CoMotionError::invalid(format!("寫入投影片時發生錯誤：{virtual_path}")))
}

/// Writes `content` to a virtual path that must not already exist — the
/// creation counterpart to `write_presentation_file` (`slide add`/
/// `template add`'s new file). Undo for a created file deletes it instead of
/// restoring prior content (`history::stage_new_file_entry`).
pub fn create_presentation_file(
    id: &str,
    virtual_path: &str,
    content: &[u8],
) -> CoMotionResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let already_exists = virtual_fs::resolve_virtual_file_path(&work_dir, virtual_path).is_ok();
    if already_exists {
        return Err(CoMotionError::invalid(format!(
            "檔案已存在：{virtual_path}"
        )));
    }

    let entry = history::stage_new_file_entry(virtual_path);
    let mut real_path = work_dir.clone();
    for segment in virtual_path.split('/').filter(|s| !s.is_empty()) {
        real_path.push(segment);
    }
    let write_result: std::io::Result<()> = (|| {
        if let Some(parent) = real_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&real_path, content)
    })();
    if write_result.is_err() {
        history::discard_snapshot_entries(id, std::slice::from_ref(&entry))?;
        // real_path is a real filesystem path (ADR-0004) — never quote it.
        return Err(CoMotionError::invalid(format!(
            "寫入檔案時發生錯誤：{virtual_path}"
        )));
    }
    let commit = history::commit_snapshot_entries(id, vec![entry])?;
    history::finalize_committed_entries(id, &commit.pending_deletion_snapshot_ids)?;
    Ok(())
}

/// Deletes an existing virtual path (`slide delete`/`template delete`). The
/// deletion counterpart to `write_presentation_file`: the file's current
/// content is snapshotted first, so undo restores it exactly.
pub fn delete_presentation_file(id: &str, virtual_path: &str) -> CoMotionResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let real_path = virtual_fs::resolve_virtual_file_path(&work_dir, virtual_path)?;
    let entries = history::stage_snapshot_entries(id, &[virtual_path.to_string()])?;
    match std::fs::remove_file(&real_path) {
        Ok(()) => {
            let commit = history::commit_snapshot_entries(id, entries)?;
            history::finalize_committed_entries(id, &commit.pending_deletion_snapshot_ids)?;
            Ok(())
        }
        Err(_) => {
            history::discard_snapshot_entries(id, &entries)?;
            // real_path is a real filesystem path (ADR-0004) — never quote it.
            Err(CoMotionError::invalid(format!(
                "刪除檔案時發生錯誤：{virtual_path}"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-write-{label}-{}",
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
            let guard = crate::workspace::registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            let id = format!("test-{label}");
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }
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
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    #[test]
    fn write_presentation_file_overwrites_and_is_undoable() {
        let fixture = Fixture::new("write-basic");
        std::fs::write(fixture.work.join("project.json"), "OLD").unwrap();
        write_presentation_file(&fixture.id, "project.json", "NEW").unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
            "NEW"
        );

        let undo_result = crate::history::undo(&fixture.id).unwrap();
        assert_eq!(undo_result.restored_paths, vec!["project.json".to_string()]);
        assert_eq!(
            std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
            "OLD"
        );
    }

    #[test]
    fn write_presentation_file_without_history_does_not_occupy_undo_step() {
        let fixture = Fixture::new("write-no-history");
        std::fs::write(fixture.work.join("project.json"), "OLD").unwrap();
        write_presentation_file_without_history(&fixture.id, "project.json", "NEW").unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.work.join("project.json")).unwrap(),
            "NEW"
        );

        let err = crate::history::undo(&fixture.id).unwrap_err();
        assert_eq!(err.message(), "沒有可復原的操作");
    }

    #[test]
    fn create_presentation_file_rejects_existing_path() {
        let fixture = Fixture::new("create-exists");
        std::fs::write(fixture.work.join("project.json"), "X").unwrap();
        let err = create_presentation_file(&fixture.id, "project.json", b"Y").unwrap_err();
        assert_eq!(err.message(), "檔案已存在：project.json");
    }

    #[test]
    fn create_presentation_file_writes_new_file_and_undo_deletes_it() {
        let fixture = Fixture::new("create-new");
        std::fs::write(fixture.work.join("project.json"), "{}").unwrap();
        create_presentation_file(&fixture.id, "assets/new.png", b"\x89PNG").unwrap();
        assert_eq!(
            std::fs::read(fixture.work.join("assets/new.png")).unwrap(),
            b"\x89PNG"
        );

        let undo_result = crate::history::undo(&fixture.id).unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["assets/new.png".to_string()]
        );
        assert!(!Path::new(&fixture.work).join("assets/new.png").exists());
    }

    #[test]
    fn delete_presentation_file_removes_and_undo_restores() {
        let fixture = Fixture::new("delete-basic");
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        std::fs::write(fixture.work.join("slides/001.svg"), b"<svg/>").unwrap();
        delete_presentation_file(&fixture.id, "slides/001.svg").unwrap();
        assert!(!fixture.work.join("slides/001.svg").exists());

        let undo_result = crate::history::undo(&fixture.id).unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(
            std::fs::read(fixture.work.join("slides/001.svg")).unwrap(),
            b"<svg/>"
        );
    }
}
