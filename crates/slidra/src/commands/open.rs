// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra open <path>`.

use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::{argv, deck, workbench};
use std::path::Path;

pub fn run(args: &[String]) -> CommandResult {
    let path = match argv::require_positional(args, 0, "open", "path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };

    match open_presentation(&path) {
        Ok(new_id) => CommandResult::success(
            format!("opened presentation, id: {new_id}"),
            Some(serde_json::json!({ "id": new_id })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), FailureKind::Failed),
    }
}

/// Opens `path` in place: migrates it to the SQLite container format first
/// if it is still a legacy ZIP (a no-op otherwise — `deck::migrate_legacy_zip_in_place`
/// is idempotent), then registers a fresh id pointing directly at `path`
/// itself. There is no separate work directory to copy into any more
/// (`spec/rfcs/0001-sqlite-container-format.md`) — `path` IS the
/// presentation's content from this point on, exactly as `pack`ing back to
/// it will later find it.
fn open_presentation(path: &str) -> Result<String, SlidraError> {
    let deck_path = Path::new(path).to_path_buf();

    deck::migrate_legacy_zip_in_place(&deck_path)?;
    // Opening validates the header (application_id/user_version) even when
    // no migration was needed — an unrecognized or too-new file must never
    // be registered.
    deck::open_connection(&deck_path)?;

    workbench::runtime::open(&deck_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::runtime;
    use crate::{id, workspace};
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-open-{label}-{}",
            id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_path_argument_fails() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "command open missing argument: path");
    }

    #[test]
    fn nonexistent_file_fails_not_not_found() {
        let _guard = runtime::ENV_LOCK.lock().unwrap();
        let home = temp_dir("nonexistent-home");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let result = run(&["/nonexistent/path/x.slidra".to_string()]);
        assert!(!result.ok);
        assert_eq!(
            result.failure_kind,
            Some(crate::result::FailureKind::Failed)
        );
        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
    }

    /// A legacy ZIP `open`ed migrates in place and registers at the
    /// crate's current `formatVersion` (5, not the legacy file's own 1) —
    /// renamed from `..._at_formatversion_1` (Plan §6's test inventory)
    /// since that value itself is the whole point of migration.
    #[test]
    fn opens_a_legacy_zip_migrates_it_and_registers_it_at_formatversion_5() {
        let _guard = runtime::ENV_LOCK.lock().unwrap();
        let home = temp_dir("open-success-home");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }

        let slidra_dir = temp_dir("open-success-slidra");
        let slidra_path = slidra_dir.join("in.slidra");
        crate::container::write_legacy_zip(
            &slidra_path,
            &[
                (
                    "slides/001.svg",
                    b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>\n",
                ),
                (
                    "project.json",
                    br#"{"formatVersion":1,"name":"T","canvas":{"width":1,"height":1},"slides":["slides/001.svg"]}"#,
                ),
            ],
        );

        let result = run(&[slidra_path.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);
        let new_id = result.data.as_ref().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let deck_path = workspace::resolve_work_dir(&new_id).unwrap();
        assert_eq!(deck_path, slidra_path, "open operates on the file in place");
        let project = crate::workspace::project::read_project_json(&deck_path).unwrap();
        assert_eq!(project.format_version, 5.0);
        assert_eq!(
            crate::deck::detect_format(&deck_path).unwrap(),
            crate::deck::ContainerFormat::Sqlite
        );

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&slidra_dir).ok();
    }

    /// Opening an already-migrated deck a second time is idempotent: the
    /// second `open` does not re-migrate (nothing changes about the file
    /// besides gaining a second registry entry).
    #[test]
    fn opening_an_already_sqlite_deck_twice_is_idempotent() {
        let _guard = runtime::ENV_LOCK.lock().unwrap();
        let home = temp_dir("open-idempotent-home");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let slidra_dir = temp_dir("open-idempotent-slidra");
        let slidra_path = slidra_dir.join("in.slidra");
        crate::container::write_legacy_zip(
            &slidra_path,
            &[(
                "project.json",
                br#"{"formatVersion":1,"name":"T","canvas":{"width":1,"height":1},"slides":[]}"#,
            )],
        );

        let first = run(&[slidra_path.to_string_lossy().into_owned()]);
        assert!(first.ok);
        let before = std::fs::read(&slidra_path).unwrap();

        let second = run(&[slidra_path.to_string_lossy().into_owned()]);
        assert!(second.ok, "expected success, got {}", second.message);
        let after = std::fs::read(&slidra_path).unwrap();
        assert_eq!(before, after, "a second open must not re-migrate");
        assert_ne!(
            first.data.as_ref().unwrap()["id"],
            second.data.as_ref().unwrap()["id"],
            "each open mints its own id even for the same deck path"
        );

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&slidra_dir).ok();
    }
}
