// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra extract <id|path> <dir>` — writes a deck's entire virtual
//! filesystem out as plain real files under `dir`. The escape hatch
//! `spec/rfcs/0001-sqlite-container-format.md` decision 6 names: since
//! migration is one-way and keeps no backup, `extract` is how an author
//! gets back to "just files on disk" if they ever need to, without
//! depending on any tool that understands the SQLite container format.
//!
//! `<id|path>` accepts either an already-`open`ed presentation id OR a
//! filesystem path directly (legacy ZIP or SQLite, not yet opened) — this
//! command never registers anything and never migrates a legacy file in
//! place, so it is safe to run against a `.slidra` an author does not want
//! touched.

use crate::errors::{SlidraError, SlidraResult};
use crate::result::{CommandResult, FailureKind};
use crate::{argv, deck, workspace};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn run(args: &[String]) -> CommandResult {
    let id_or_path = match argv::require_id_positional(args, 0, "extract", "id-or-path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let dir = match argv::require_positional(args, 1, "extract", "dir") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };

    match extract_presentation(&id_or_path, &dir) {
        Ok(()) => {
            CommandResult::success(format!("extracted to {dir}"), Some(serde_json::json!({})))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn failure_kind_for(err: &SlidraError) -> FailureKind {
    match err {
        SlidraError::NotFound(_) => FailureKind::NotFound,
        SlidraError::InvalidRequest(_) => FailureKind::Failed,
    }
}

/// Resolves `id_or_path`: a registered presentation id first, falling back
/// to treating the value as a literal filesystem path when it is not a
/// known id — the same "not found" from `registry::lookup` a random
/// string would produce either way, so trying the id lookup first can
/// never mask a genuine path.
fn resolve_deck_path(id_or_path: &str) -> PathBuf {
    match workspace::registry::lookup(id_or_path) {
        Ok(entry) => entry.deck_path,
        Err(_) => PathBuf::from(id_or_path),
    }
}

fn extract_presentation(id_or_path: &str, dir: &str) -> SlidraResult<()> {
    let deck_path = resolve_deck_path(id_or_path);
    let target = Path::new(dir);
    assert_target_dir_usable(target, dir)?;

    match deck::detect_format(&deck_path)? {
        deck::ContainerFormat::LegacyZip => extract_legacy_zip(&deck_path, target, dir),
        deck::ContainerFormat::Sqlite => extract_sqlite_deck(&deck_path, target, dir),
    }
}

/// `dir` must not already exist as a non-empty directory, and must not
/// exist as a non-directory at all — matches the behavior table's "target
/// directory already exists and is non-empty" row (no overwrite, no
/// merge). A missing or empty directory is fine either way.
fn assert_target_dir_usable(target: &Path, dir: &str) -> SlidraResult<()> {
    match std::fs::metadata(target) {
        Err(_) => Ok(()), // does not exist yet — created below
        Ok(metadata) if !metadata.is_dir() => Err(SlidraError::invalid(format!(
            "specified path is not a directory: {dir}"
        ))),
        Ok(_) => {
            let non_empty = std::fs::read_dir(target)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);
            if non_empty {
                return Err(SlidraError::invalid(format!(
                    "target directory already exists and is not empty: {dir}"
                )));
            }
            Ok(())
        }
    }
}

fn write_real_file(target: &Path, virtual_path: &str, bytes: &[u8], dir: &str) -> SlidraResult<()> {
    let mut dest = target.to_path_buf();
    for segment in virtual_path.split('/').filter(|s| !s.is_empty()) {
        dest.push(segment);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| SlidraError::invalid(format!("error writing file: {dir}")))?;
    }
    std::fs::write(&dest, bytes)
        .map_err(|_| SlidraError::invalid(format!("error writing file: {dir}")))
}

fn create_real_dir(target: &Path, virtual_path: &str, dir: &str) -> SlidraResult<()> {
    let mut dest = target.to_path_buf();
    for segment in virtual_path.split('/').filter(|s| !s.is_empty()) {
        dest.push(segment);
    }
    std::fs::create_dir_all(&dest)
        .map_err(|_| SlidraError::invalid(format!("error writing file: {dir}")))
}

fn extract_sqlite_deck(deck_path: &Path, target: &Path, dir: &str) -> SlidraResult<()> {
    std::fs::create_dir_all(target)
        .map_err(|_| SlidraError::invalid(format!("error writing file: {dir}")))?;
    for dir_path in workspace::virtual_fs::list_virtual_dirs(deck_path)? {
        create_real_dir(target, &dir_path, dir)?;
    }
    for file_path in workspace::virtual_fs::list_virtual_files(deck_path, "")? {
        let bytes = workspace::virtual_fs::read_virtual_file_bytes(deck_path, &file_path)?;
        write_real_file(target, &file_path, &bytes, dir)?;
    }
    Ok(())
}

fn extract_legacy_zip(deck_path: &Path, target: &Path, dir: &str) -> SlidraResult<()> {
    let files: BTreeMap<String, Vec<u8>> = crate::container::read_legacy_zip(deck_path)?;
    std::fs::create_dir_all(target)
        .map_err(|_| SlidraError::invalid(format!("error writing file: {dir}")))?;
    for &required in crate::container::REQUIRED_DIRS.iter() {
        create_real_dir(target, required, dir)?;
    }
    for (file_path, bytes) in &files {
        write_real_file(target, file_path, bytes, dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "slidra-test-extract-{label}-{}",
            crate::id::random_hex_suffix()
        ))
    }

    #[test]
    fn missing_arguments_fail() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command extract missing argument: id-or-path"
        );
    }

    #[test]
    fn extract_reproduces_every_virtual_path_including_empty_directories() {
        let guard = workspace::registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("sqlite-home");
        std::fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let deckfile = crate::deck::build_test_deck(
            "sqlite",
            &[
                (
                    "project.json",
                    br#"{"formatVersion":5,"name":"T","canvas":{"width":1,"height":1},"slides":["slides/001.svg"]}"#,
                ),
                ("slides/001.svg", b"<svg/>"),
                ("assets/data/sales.csv", b"a,b\n1,2\n"),
            ],
        );
        let id = "pid-extract-sqlite";
        workspace::registry::register_for_test(&home, id, &deckfile);

        let out_dir = temp_dir("sqlite-out");
        let result = run(&[id.to_string(), out_dir.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);

        assert!(out_dir.join("slides/001.svg").is_file());
        assert!(out_dir.join("assets/data/sales.csv").is_file());
        // Empty required directory with no files at all still exists as a
        // real directory on disk.
        assert!(out_dir.join("fonts").is_dir());
        assert_eq!(
            std::fs::read(out_dir.join("slides/001.svg")).unwrap(),
            b"<svg/>"
        );

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        drop(guard);
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_file(&deckfile).ok();
        std::fs::remove_dir_all(&out_dir).ok();
    }

    #[test]
    fn refuses_a_non_empty_existing_target_directory() {
        let guard = workspace::registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("nonempty-home");
        std::fs::create_dir_all(&home).unwrap();
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let deckfile = crate::deck::build_test_deck(
            "nonempty",
            &[(
                "project.json",
                br#"{"formatVersion":5,"name":"T","canvas":{"width":1,"height":1},"slides":[]}"#,
            )],
        );
        let id = "pid-extract-nonempty";
        workspace::registry::register_for_test(&home, id, &deckfile);

        let out_dir = temp_dir("nonempty-out");
        std::fs::create_dir_all(&out_dir).unwrap();
        std::fs::write(out_dir.join("existing.txt"), b"x").unwrap();

        let result = run(&[id.to_string(), out_dir.to_string_lossy().into_owned()]);
        assert!(!result.ok);
        assert!(result.message.contains("already exists and is not empty"));

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        drop(guard);
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_file(&deckfile).ok();
        std::fs::remove_dir_all(&out_dir).ok();
    }
}
