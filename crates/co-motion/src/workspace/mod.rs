//! Workspace resolution, ported from `packages/core/src/workspace.ts`
//! (home-dir resolution, the registry read, id-to-workDir lookup,
//! `assertSlidePathListed`/`writePresentationFile`) plus `project-json.ts`
//! and `virtual-fs.ts` in the `project`/`virtual_fs` submodules. This module
//! writes no `projects.json` and does no container packing/unpacking or
//! format-version migration — all of that belongs to a later ticket. The
//! writes it DOES perform (via `write`) are presentation content edits
//! through the undo/redo staging API in `history.rs` — the same mechanism
//! `undo`/`redo` themselves replay.
//!
//! Public API:
//! - `resolve_home() -> PathBuf` — `CO_MOTION_HOME`, defaulting to
//!   `$HOME/.comotion`. Re-reads the env var on every call (never cached),
//!   matching the TS original's stated reason: tests point it at a fresh
//!   temp dir per case.
//! - `resolve_work_dir(id) -> CoMotionResult<PathBuf>` — the one place an
//!   opaque presentation id becomes a real directory. `CoMotionError::NotFound`
//!   when `id` is not registered.
//! - `registry::lookup(id) -> CoMotionResult<RegistryEntry>` — the lower-level
//!   read `resolve_work_dir` is built on, in case a future caller needs more
//!   of the registry entry than just `work_dir`.
//! - `project` — `project.json` read/parse/validate (see `project.rs`).
//! - `virtual_fs` — virtual path resolution within a work dir (see
//!   `virtual_fs.rs`).
//! - `write` — `assert_slide_path_listed`/`write_presentation_file` (see
//!   `write.rs`).

pub mod project;
pub mod virtual_fs;
pub mod write;

use crate::errors::CoMotionResult;
use std::path::PathBuf;

/// Resolves `CO_MOTION_HOME`, defaulting to `~/.comotion`. Read fresh on
/// every call — not cached in a `OnceLock`/static — so a caller (or a test)
/// that changes the env var between calls is honoured immediately, exactly
/// as `process.env.CO_MOTION_HOME` is read fresh on every TS call.
///
/// `env::var_os` (not `env::var`) is used deliberately: TS's `??` operator
/// only falls back on `undefined`/`null`, so `CO_MOTION_HOME=""` is a valid
/// (if unusual) value that must be used as-is. Reading as `OsString` also
/// means a set-but-not-valid-UTF-8 value is honoured as a path rather than
/// silently forced into the "unset" branch, which `env::var` would do.
pub fn resolve_home() -> PathBuf {
    match std::env::var_os("CO_MOTION_HOME") {
        Some(value) => PathBuf::from(value),
        None => home_dir().join(".comotion"),
    }
}

/// Best-effort `$HOME` lookup for the `CO_MOTION_HOME`-unset fallback path.
///
/// NOT a full port of Node's `os.homedir()`: on POSIX, `os.homedir()` falls
/// back to a `getpwuid()` lookup by effective UID when `$HOME` is itself
/// unset, so a process launched with no `HOME` in its environment still
/// resolves a home directory. Reproducing that here would mean hand-rolling
/// `libc` FFI bindings with no `libc` crate in this workspace's dependency
/// budget (fixed at clap/serde/serde_json — see `id.rs`), for a fallback of
/// a fallback that only matters when both `CO_MOTION_HOME` and `HOME` are
/// unset. This is the one deliberate behavioral gap in this port — flagged
/// here rather than silently guessed at.
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Read-only registry access: resolving a presentation id to the `workDir`
/// `packages/core/src/workspace.ts`'s `openPresentation` registered it
/// under. Ported from that file's `readRegistry`/`isRegistryEntry`/
/// `lookupWorkDir` — the read slice only. This module never calls
/// `writeRegistry`; nothing here can create or mutate `projects.json`.
pub mod registry {
    use super::resolve_home;
    use crate::errors::{CoMotionError, CoMotionResult};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    /// One `projects.json` entry, read-only. Only `work_dir` is modeled:
    /// the ticket's scope is "resolving a presentation id to its workDir",
    /// not the full `RegistryEntry` shape (`sourcePath`/`savedAt`) that
    /// `workspace.ts`'s save-state tracking uses — a later ticket's job.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct RegistryEntry {
        pub work_dir: PathBuf,
    }

    fn registry_path(home: &Path) -> PathBuf {
        home.join("projects.json")
    }

    /// Reads and validates `projects.json`. A genuinely missing file is an
    /// empty registry (nothing has ever been `open`ed under this home yet);
    /// every other failure — malformed JSON, an I/O error, a malformed
    /// entry — is a loud, distinct `CoMotionError`, never a silent fallback
    /// to empty (same stance the TS original documents: falling back to
    /// empty here would make every previously opened presentation
    /// unreachable).
    fn read_registry(home: &Path) -> CoMotionResult<HashMap<String, RegistryEntry>> {
        let raw = match std::fs::read_to_string(registry_path(home)) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HashMap::new());
            }
            // A genuine operational failure reading the registry itself, as
            // opposed to the file simply not existing yet (handled above).
            Err(_) => return Err(CoMotionError::invalid("無法讀取簡報登記資料")),
        };

        let parsed: Value =
            serde_json::from_str(&raw).map_err(|_| CoMotionError::invalid("簡報登記資料已損毀"))?;
        // `Value::as_object()` returns `None` for a JSON array too, which
        // covers the TS original's separate `Array.isArray(parsed)` check.
        let obj = parsed
            .as_object()
            .ok_or_else(|| CoMotionError::invalid("簡報登記資料已損毀"))?;

        let mut registry = HashMap::with_capacity(obj.len());
        for (id, value) in obj {
            let work_dir = value
                .as_object()
                .and_then(|entry| entry.get("workDir"))
                .and_then(Value::as_str);
            let work_dir = match work_dir {
                Some(path) => path,
                None => {
                    return Err(CoMotionError::invalid(format!("簡報登記資料已損毀：{id}")));
                }
            };
            registry.insert(
                id.clone(),
                RegistryEntry {
                    work_dir: PathBuf::from(work_dir),
                },
            );
        }
        Ok(registry)
    }

    /// Resolves an opaque presentation id to its registry entry — the one
    /// place in this crate that does this. `CoMotionError::NotFound` when
    /// `id` is not registered at all (as opposed to the registry itself
    /// being unreadable/corrupt, which is a plain `CoMotionError`).
    pub fn lookup(id: &str) -> CoMotionResult<RegistryEntry> {
        let home = resolve_home();
        let mut registry = read_registry(&home)?;
        registry
            .remove(id)
            .ok_or_else(|| CoMotionError::not_found(format!("找不到識別碼對應的簡報：{id}")))
    }

    /// Serializes access to the `CO_MOTION_HOME` env var across this
    /// crate's tests. `std::env::set_var`/`remove_var` mutate global process
    /// state; `cargo test` runs tests in one process by default, so any two
    /// tests that both read/write this env var without coordinating would
    /// race. Every test in this crate that sets `CO_MOTION_HOME` (directly,
    /// or indirectly by calling `resolve_home`/`registry::lookup`/
    /// `resolve_work_dir`/anything in `history.rs`) must hold this lock for
    /// the duration of that mutation.
    #[cfg(test)]
    pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp_dir(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "co-motion-test-registry-{label}-{}",
                crate::id::random_hex_suffix()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn co_motion_home_unset_vs_empty_string() {
            let _guard = ENV_LOCK.lock().unwrap();
            let previous = std::env::var_os("CO_MOTION_HOME");
            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }

            // Unset: falls back to $HOME/.comotion.
            let home_env = std::env::var_os("HOME");
            let unset_result = resolve_home();
            if let Some(home) = &home_env {
                assert_eq!(unset_result, PathBuf::from(home).join(".comotion"));
            }

            // Empty string: TS's `??` only falls back on undefined/null, so
            // an empty string is used as-is, NOT treated as unset.
            unsafe {
                std::env::set_var("CO_MOTION_HOME", "");
            }
            let empty_result = resolve_home();
            assert_eq!(empty_result, PathBuf::from(""));
            assert_ne!(empty_result, unset_result);

            match previous {
                Some(value) => unsafe { std::env::set_var("CO_MOTION_HOME", value) },
                None => unsafe { std::env::remove_var("CO_MOTION_HOME") },
            }
        }

        #[test]
        fn missing_projects_json_is_empty_registry_not_error() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("missing-file");
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }

            let err = lookup("whatever-id").unwrap_err();
            // NotFound (not InvalidRequest) proves the missing file was
            // treated as an empty registry, not a corrupted one.
            assert!(matches!(err, CoMotionError::NotFound(_)));
            assert_eq!(err.message(), "找不到識別碼對應的簡報：whatever-id");

            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }

        #[test]
        fn malformed_projects_json_is_corrupted_error() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("malformed");
            std::fs::write(home.join("projects.json"), "{not valid json").unwrap();
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }

            let err = lookup("any-id").unwrap_err();
            assert!(matches!(err, CoMotionError::InvalidRequest(_)));
            assert_eq!(err.message(), "簡報登記資料已損毀");

            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }

        #[test]
        fn registry_entry_missing_work_dir_is_corrupted_error() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("missing-workdir");
            std::fs::write(home.join("projects.json"), r#"{"abc123":{"foo":"bar"}}"#).unwrap();
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }

            let err = lookup("abc123").unwrap_err();
            assert_eq!(err.message(), "簡報登記資料已損毀：abc123");

            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }

        #[test]
        fn unknown_id_lookup_is_not_found() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("unknown-id");
            std::fs::write(
                home.join("projects.json"),
                r#"{"known-id":{"workDir":"/tmp/somewhere"}}"#,
            )
            .unwrap();
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }

            let err = lookup("unknown-id").unwrap_err();
            assert!(matches!(err, CoMotionError::NotFound(_)));
            assert_eq!(err.message(), "找不到識別碼對應的簡報：unknown-id");

            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }

        #[test]
        fn known_id_resolves_work_dir() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("known-id");
            std::fs::write(
                home.join("projects.json"),
                r#"{"known-id":{"workDir":"/tmp/known-work-dir"}}"#,
            )
            .unwrap();
            unsafe {
                std::env::set_var("CO_MOTION_HOME", &home);
            }

            let entry = lookup("known-id").unwrap();
            assert_eq!(entry.work_dir, PathBuf::from("/tmp/known-work-dir"));

            unsafe {
                std::env::remove_var("CO_MOTION_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }
    }
}

/// Resolves an opaque presentation id to its real work directory — mirrors
/// `packages/core/src/workspace.ts`'s exported `resolveWorkDir`.
pub fn resolve_work_dir(id: &str) -> CoMotionResult<PathBuf> {
    Ok(registry::lookup(id)?.work_dir)
}
