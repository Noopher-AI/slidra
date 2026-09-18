// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra pack <presentation-id> <path>`.

use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::{argv, workbench};
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
    let deck_path = workbench::runtime::resolve_deck_path(id)?;

    let output_resolved = resolve_lexically(Path::new(output_path));
    let is_same_file = output_resolved == resolve_lexically(&deck_path);
    if !is_same_file {
        // A plain file copy, staged then renamed: the deck IS the
        // container format now, so "pack to a different path" is just
        // "duplicate this file" — no directory walk, no re-compression.
        copy_deck_staged(&deck_path, Path::new(output_path))?;
    }
    // "no copy, no VACUUM" (behavior table) only when the target IS the
    // deck's own file — a target that merely matches the *source* path
    // below still gets copied above, since the deck's current content can
    // have diverged from what is sitting at that remembered path
    // (`packages/server`'s `reopenPresentationInPlace` updates `source_path`
    // independently of `deck_path`).

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
        let result = run(&["nope".to_string(), "/tmp/out.slidra".to_string()]);
        assert!(!result.ok);
        assert_eq!(
            result.failure_kind,
            Some(crate::result::FailureKind::NotFound)
        );
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
    fn packing_to_the_deck_s_own_path_is_a_no_op() {
        let deck = minimal_deck("same-file");
        let id = crate::workbench::runtime::open(&deck).unwrap();
        let before = std::fs::read(&deck).unwrap();
        let result = run(&[id, deck.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);
        assert_eq!(std::fs::read(&deck).unwrap(), before);
        std::fs::remove_file(&deck).ok();
    }

    /// Packing to a path that matches the registry's remembered
    /// `source_path` but is NOT the deck's own file still copies the
    /// deck's current bytes there (the two can diverge —
    /// `packages/server`'s `reopenPresentationInPlace` updates
    /// `source_path` independently of `deck_path`) — then updates
    /// `saved_at`, since the target now matches source.
    #[test]
    fn packing_to_a_different_path_copies_exact_bytes() {
        let deck = minimal_deck("same-source");
        let output = temp_dir("same-source-output").join("out.slidra");
        let id = crate::workbench::runtime::open(&deck).unwrap();
        let result = run(&[id, output.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);
        assert!(output.exists());
        assert_eq!(
            std::fs::read(&output).unwrap(),
            std::fs::read(&deck).unwrap()
        );

        std::fs::remove_file(&deck).ok();
        std::fs::remove_file(&output).ok();
    }
}
