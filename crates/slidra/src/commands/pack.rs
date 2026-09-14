// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra pack <presentation-id> <path>`.

use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::workspace::registry::RegistryEntry;
use crate::{argv, workspace};
use std::path::{Path, PathBuf};

pub fn run(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "pack", "id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let path = match argv::require_positional(args, 1, "pack", "path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };

    match pack_presentation(&id, &path) {
        Ok(()) => CommandResult::success("packaging complete", Some(serde_json::json!({}))),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn pack_presentation(id: &str, output_path: &str) -> Result<(), SlidraError> {
    let home = workspace::resolve_home();
    let registry = workspace::registry::read_registry(&home)?;
    let Some(entry) = registry.get(id).cloned() else {
        return Err(SlidraError::not_found(format!(
            "no presentation found for id: {id}"
        )));
    };

    let output_resolved = resolve_lexically(Path::new(output_path));
    let is_same_file = output_resolved == resolve_lexically(&entry.deck_path);
    if !is_same_file {
        // A plain file copy, staged then renamed: the deck IS the
        // container format now, so "pack to a different path" is just
        // "duplicate this file" — no directory walk, no re-compression.
        copy_deck_staged(&entry.deck_path, Path::new(output_path))?;
    }
    // "no copy, no VACUUM" (behavior table) only when the target IS the
    // deck's own file — a target that merely matches the *source* path
    // below still gets copied above, since the deck's current content can
    // have diverged from what is sitting at that remembered path
    // (`packages/server`'s `reopenPresentationInPlace` updates `source_path`
    // independently of `deck_path`).

    let is_same_as_source = entry
        .source_path
        .as_ref()
        .map(|source_path| output_resolved == resolve_lexically(source_path))
        .unwrap_or(false);
    if is_same_as_source {
        let saved_at = workspace::registry::deck_file_mtime_millis(&entry.deck_path)?
            + workspace::registry::SAVED_AT_SETTLE_WINDOW_MS;
        // Re-read inside the lock rather than reusing the map read above:
        // packing runs between the two, and anything another process
        // registered meanwhile must survive this write.
        workspace::registry::with_registry_lock(&home, || {
            let mut registry = workspace::registry::read_registry(&home)?;
            registry.insert(
                id.to_string(),
                RegistryEntry {
                    saved_at: Some(saved_at),
                    ..entry
                },
            );
            workspace::registry::write_registry(&home, &registry)
        })?;
    }
    Ok(())
}

/// Copies `source`'s bytes to `dest` via a same-directory temp file plus
/// `rename`, so a reader of `dest` never observes a partially-written
/// file. Overwrites an existing `dest`, matching the pre-SQLite
/// `pack_directory`'s own unconditional-overwrite contract.
fn copy_deck_staged(source: &Path, dest: &Path) -> Result<(), SlidraError> {
    let display = dest.display().to_string();
    let bytes = std::fs::read(source).map_err(|_| {
        SlidraError::invalid(format!("failed to read presentation file: {display}"))
    })?;
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|_| {
                SlidraError::invalid(format!("failed to write presentation file: {display}"))
            })?;
        }
    }
    let temp_path = dest.with_file_name(format!(
        ".{}.{}.tmp",
        dest.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "deck".to_string()),
        crate::id::random_hex_suffix()
    ));
    let write_result: std::io::Result<()> = (|| {
        std::fs::write(&temp_path, &bytes)?;
        std::fs::rename(&temp_path, dest)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
        return Err(SlidraError::invalid(format!(
            "failed to write presentation file: {display}"
        )));
    }
    Ok(())
}

/// Node's `path.resolve` semantics: absolute + lexically normalized against
/// the current working directory, WITHOUT touching the filesystem (no
/// symlink resolution, no existence requirement) — unlike
/// `Path::canonicalize`, which requires the path to exist. Used only to
/// compare `output_path` against a registry entry's `source_path` the same
/// way `packPresentation`'s `path.resolve(a) === path.resolve(b)` does.
fn resolve_lexically(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
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
            "slidra-test-pack-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_arguments_fail() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "command pack missing argument: id");
    }

    #[test]
    fn unknown_id_is_not_found() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("unknown-id-home");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let result = run(&["nope".to_string(), "/tmp/out.slidra".to_string()]);
        assert!(!result.ok);
        assert_eq!(
            result.failure_kind,
            Some(crate::result::FailureKind::NotFound)
        );
        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
    }

    fn minimal_deck(label: &str) -> PathBuf {
        crate::deck::build_test_deck(
            label,
            &[(
                "project.json",
                br#"{"formatVersion":5,"name":"X","canvas":{"width":1,"height":1},"slides":[],"fonts":[]}"#,
            )],
        )
    }

    #[test]
    fn packing_to_the_deck_s_own_path_updates_saved_at_without_copying() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("same-file-home");
        let deck = minimal_deck("same-file");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let mut registry_map = std::collections::HashMap::new();
        registry_map.insert(
            "id1".to_string(),
            RegistryEntry {
                deck_path: deck.clone(),
                source_path: Some(deck.clone()),
                saved_at: Some(0.0),
            },
        );
        workspace::registry::write_registry(&home, &registry_map).unwrap();

        let result = run(&["id1".to_string(), deck.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);

        let updated_registry = workspace::registry::read_registry(&home).unwrap();
        assert!(updated_registry["id1"].saved_at.unwrap() > 0.0);

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_file(&deck).ok();
    }

    /// Packing to a path that matches the registry's remembered
    /// `source_path` but is NOT the deck's own file still copies the
    /// deck's current bytes there (the two can diverge —
    /// `packages/server`'s `reopenPresentationInPlace` updates
    /// `source_path` independently of `deck_path`) — then updates
    /// `saved_at`, since the target now matches source.
    #[test]
    fn packing_to_a_remembered_source_path_copies_and_updates_saved_at() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("same-source-home");
        let deck = minimal_deck("same-source");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let output = temp_dir("same-source-output").join("out.slidra");
        let mut registry_map = std::collections::HashMap::new();
        registry_map.insert(
            "id1".to_string(),
            RegistryEntry {
                deck_path: deck.clone(),
                source_path: Some(output.clone()),
                saved_at: Some(0.0),
            },
        );
        workspace::registry::write_registry(&home, &registry_map).unwrap();

        let result = run(&["id1".to_string(), output.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);
        assert!(output.exists());
        assert_eq!(
            std::fs::read(&output).unwrap(),
            std::fs::read(&deck).unwrap()
        );

        let updated_registry = workspace::registry::read_registry(&home).unwrap();
        assert!(updated_registry["id1"].saved_at.unwrap() > 0.0);

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_file(&deck).ok();
        std::fs::remove_file(&output).ok();
    }

    #[test]
    fn packing_to_a_different_path_leaves_saved_at_untouched() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("diff-path-home");
        let deck = minimal_deck("diff-path");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let mut registry_map = std::collections::HashMap::new();
        registry_map.insert(
            "id1".to_string(),
            RegistryEntry {
                deck_path: deck.clone(),
                source_path: Some(PathBuf::from("/some/other/path.slidra")),
                saved_at: Some(0.0),
            },
        );
        workspace::registry::write_registry(&home, &registry_map).unwrap();

        let output = temp_dir("diff-path-output").join("out.slidra");
        let result = run(&["id1".to_string(), output.to_string_lossy().into_owned()]);
        assert!(result.ok);
        assert!(output.exists());

        let updated_registry = workspace::registry::read_registry(&home).unwrap();
        assert_eq!(updated_registry["id1"].saved_at, Some(0.0));

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_file(&deck).ok();
        std::fs::remove_file(&output).ok();
    }
}
