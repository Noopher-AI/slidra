// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Workspace read AND write paths: home-dir resolution, the registry read,
//! id-to-workDir lookup, project-json and virtual-fs logic in the
//! `project`/`virtual_fs` submodules. The `registry` submodule also writes
//! `projects.json` (`new`/`open`/`pack` need to register/update a
//! presentation), and `write.rs` holds the content-write doors
//! (`assert_slide_path_listed`, `write_presentation_file` and friends,
//! plus `require_slide` and the per-presentation clipboard file I/O).
//! Container packing/unpacking lives in `container.rs`.
//! `list_presentation_entries` (`asset import`'s conflict-free-filename
//! scan) is added directly to this file, and a
//! `fonts` submodule for a presentation's embedded font book — every other
//! write this crate's commands need (`write_presentation_file`/
//! `create_presentation_file`/`assert_slide_path_listed`/`require_slide`)
//! reuses `write.rs`'s existing doors rather than adding its own. There is
//! no format-version migration: `FORMAT_VERSION` is fixed at 1 and
//! `project::validate_project_json` rejects anything else outright.
//!
//! Public API:
//! - `resolve_home() -> PathBuf` — `SLIDRA_HOME`, defaulting to
//!   `$HOME/.slidra`. Re-reads the env var on every call (never cached),
//!   matching the TS original's stated reason: tests point it at a fresh
//!   temp dir per case.
//! - `resolve_work_dir(id) -> SlidraResult<PathBuf>` — the one place an
//!   opaque presentation id becomes a real directory. `SlidraError::NotFound`
//!   when `id` is not registered.
//! - `registry::lookup(id) -> SlidraResult<RegistryEntry>` — the lower-level
//!   read `resolve_work_dir` is built on, in case a future caller needs more
//!   of the registry entry than just `work_dir`.
//! - `registry::write_registry`/`registry::work_dir_for`/
//!   `registry::max_mtime_in_directory` — the write-side primitives `open`/
//!   `pack` need (see `registry`'s own doc comment).
//! - `project` — `project.json` read/parse/validate/write (see `project.rs`).
//! - `virtual_fs` — virtual path resolution within a work dir (see
//!   `virtual_fs.rs`).
//! - `fonts` — a presentation's embedded font book (see `fonts.rs`).
//! - `write` — `assert_slide_path_listed`/`write_presentation_file`/
//!   `require_slide` and the clipboard file I/O (see `write.rs`).
//! - `list_presentation_entries(id, virtual_path) -> SlidraResult<Vec<String>>`
//!   — `asset import`'s conflict-free-filename scan of `assets/`/`assets/data/`.

pub mod fonts;
pub mod lock;
pub mod project;
pub mod virtual_fs;
pub mod write;

use crate::errors::SlidraResult;
use std::path::PathBuf;

/// Resolves `SLIDRA_HOME`, defaulting to `~/.slidra`. Read fresh on
/// every call — not cached in a `OnceLock`/static — so a caller (or a test)
/// that changes the env var between calls is honoured immediately, exactly
/// as `process.env.SLIDRA_HOME` is read fresh on every TS call.
///
/// `env::var_os` (not `env::var`) is used deliberately: TS's `??` operator
/// only falls back on `undefined`/`null`, so `SLIDRA_HOME=""` is a valid
/// (if unusual) value that must be used as-is. Reading as `OsString` also
/// means a set-but-not-valid-UTF-8 value is honoured as a path rather than
/// silently forced into the "unset" branch, which `env::var` would do.
pub fn resolve_home() -> PathBuf {
    match std::env::var_os("SLIDRA_HOME") {
        Some(value) => PathBuf::from(value),
        None => home_dir().join(".slidra"),
    }
}

/// Best-effort `$HOME` lookup for the `SLIDRA_HOME`-unset fallback path.
///
/// NOT a full port of Node's `os.homedir()`: on POSIX, `os.homedir()` falls
/// back to a `getpwuid()` lookup by effective UID when `$HOME` is itself
/// unset, so a process launched with no `HOME` in its environment still
/// resolves a home directory. Reproducing that here would mean hand-rolling
/// `libc` FFI bindings with no `libc` crate in this workspace's dependency
/// budget (fixed at clap/serde/serde_json — see `id.rs`), for a fallback of
/// a fallback that only matters when both `SLIDRA_HOME` and `HOME` are
/// unset. This is the one deliberate behavioral gap in this port — flagged
/// here rather than silently guessed at.
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Read-only registry access: resolving a presentation id to the `workDir`
/// the original engine's `openPresentation` registered it under — the read
/// slice only. This module never calls
/// `writeRegistry`; nothing here can create or mutate `projects.json`.
pub mod registry {
    use super::resolve_home;
    use crate::errors::{SlidraError, SlidraResult};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    /// One `projects.json` entry. `source_path`/`saved_at`: the
    /// `.slidra` path `open`/`pack` last read from or wrote to, and the work
    /// directory's own max-mtime reading at that moment — absent for an
    /// older registry entry (read side must tolerate missing fields,
    /// see `is_registry_entry`).
    #[derive(Debug, Clone, PartialEq)]
    pub struct RegistryEntry {
        pub work_dir: PathBuf,
        pub source_path: Option<PathBuf>,
        pub saved_at: Option<f64>,
    }

    fn registry_path(home: &Path) -> PathBuf {
        home.join("projects.json")
    }

    /// The advisory lock guarding a `projects.json` read-modify-write. Its
    /// name is shared verbatim with `packages/server`'s
    /// `withProjectsRegistryLock` — the two must never drift, since a lock
    /// only excludes anybody at all if every writer agrees on the path.
    fn registry_lock_path(home: &Path) -> PathBuf {
        home.join(".projects.json.lock")
    }

    /// How long to keep trying before giving up on acquiring the lock.
    const LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    /// A lock file older than this is assumed to belong to a process that
    /// died before releasing it, and is stolen. Deliberately far longer
    /// than any real read-modify-write of this file takes.
    const LOCK_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

    /// How long to wait between acquisition attempts.
    const LOCK_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(20);

    /// True when `path` exists and has not been touched for `LOCK_STALE_AFTER`.
    fn lock_is_stale(path: &Path) -> bool {
        let Ok(metadata) = std::fs::metadata(path) else {
            return false;
        };
        let Ok(modified) = metadata.modified() else {
            return false;
        };
        modified
            .elapsed()
            .map(|age| age > LOCK_STALE_AFTER)
            .unwrap_or(false)
    }

    /// Runs `body` while holding the `projects.json` advisory lock, so that
    /// a read-modify-write of the registry cannot interleave with another
    /// process's.
    ///
    /// `projects.json` is the one file the Rust CLI and `packages/server`
    /// both write, and every writer reads the whole map, changes one entry
    /// and writes the whole map back. Both sides write through a temp file
    /// then `rename`, so the file is never *torn* — but that says nothing
    /// about lost updates: two `slidra open` runs racing each other each
    /// read the same map, and whichever writes second silently drops the
    /// other's brand-new entry, leaving a work directory on disk that no id
    /// reaches any more.
    ///
    /// Held only for the duration of `body`, which must never shell out to
    /// another `slidra` command — that would deadlock against this same
    /// lock.
    ///
    /// The lock is an exclusive-create of a lock file: portable, dependency
    /// free, and released by unlinking. A process that dies while holding
    /// it leaves the file behind, so a lock nobody has touched for
    /// `LOCK_STALE_AFTER` is stolen rather than waited on forever.
    pub(crate) fn with_registry_lock<T>(
        home: &Path,
        body: impl FnOnce() -> SlidraResult<T>,
    ) -> SlidraResult<T> {
        std::fs::create_dir_all(home)
            .map_err(|_| SlidraError::invalid("failed to write presentation registry data"))?;
        let lock_path = registry_lock_path(home);
        let deadline = std::time::Instant::now() + LOCK_TIMEOUT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(_) => break,
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&lock_path) {
                        let _ = std::fs::remove_file(&lock_path);
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(SlidraError::invalid(
                            "another slidra is writing presentation registry data, please try again later",
                        ));
                    }
                    std::thread::sleep(LOCK_RETRY_INTERVAL);
                }
                Err(_) => {
                    return Err(SlidraError::invalid(
                        "failed to write presentation registry data",
                    ));
                }
            }
        }
        // Released on every path out of `body`, including a panic unwind —
        // a leaked lock file would block every later writer for
        // `LOCK_STALE_AFTER`.
        struct LockGuard(PathBuf);
        impl Drop for LockGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _guard = LockGuard(lock_path);
        body()
    }

    /// Reads and validates `projects.json`. A genuinely missing file is an
    /// empty registry (nothing has ever been `open`ed under this home yet);
    /// every other failure — malformed JSON, an I/O error, a malformed
    /// entry — is a loud, distinct `SlidraError`, never a silent fallback
    /// to empty (same stance the TS original documents: falling back to
    /// empty here would make every previously opened presentation
    /// unreachable).
    pub(crate) fn read_registry(home: &Path) -> SlidraResult<HashMap<String, RegistryEntry>> {
        let raw = match std::fs::read_to_string(registry_path(home)) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HashMap::new());
            }
            // A genuine operational failure reading the registry itself, as
            // opposed to the file simply not existing yet (handled above).
            Err(_) => {
                return Err(SlidraError::invalid(
                    "failed to read presentation registry data",
                ));
            }
        };

        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|_| SlidraError::invalid("presentation registry data is corrupted"))?;
        // `Value::as_object()` returns `None` for a JSON array too, which
        // covers the TS original's separate `Array.isArray(parsed)` check.
        let obj = parsed
            .as_object()
            .ok_or_else(|| SlidraError::invalid("presentation registry data is corrupted"))?;

        let mut registry = HashMap::with_capacity(obj.len());
        for (id, value) in obj {
            let entry_obj = value.as_object();
            let work_dir = entry_obj
                .and_then(|entry| entry.get("workDir"))
                .and_then(Value::as_str);
            let work_dir = match work_dir {
                Some(path) => path,
                None => {
                    return Err(SlidraError::invalid(format!(
                        "presentation registry data is corrupted: {id}"
                    )));
                }
            };
            let source_path = entry_obj
                .and_then(|entry| entry.get("sourcePath"))
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let saved_at = entry_obj
                .and_then(|entry| entry.get("savedAt"))
                .and_then(Value::as_f64);
            registry.insert(
                id.clone(),
                RegistryEntry {
                    work_dir: PathBuf::from(work_dir),
                    source_path,
                    saved_at,
                },
            );
        }
        Ok(registry)
    }

    /// Atomically writes the registry: a private temp file first, then
    /// `rename`d over the real `projects.json` — a crash or a full disk
    /// mid-write can never leave `projects.json` truncated or half-written.
    /// Entries are written in sorted-by-id order for a deterministic file
    /// (the TS original's `Map` preserves insertion order instead, which
    /// Rust's `HashMap` does not track — sorting is the closest equivalent
    /// that keeps repeated writes of the same registry byte-identical).
    pub fn write_registry(
        home: &Path,
        registry: &HashMap<String, RegistryEntry>,
    ) -> SlidraResult<()> {
        std::fs::create_dir_all(home)
            .map_err(|_| SlidraError::invalid("failed to write presentation registry data"))?;
        let mut ids: Vec<&String> = registry.keys().collect();
        ids.sort();
        let mut map = serde_json::Map::with_capacity(ids.len());
        for id in ids {
            let entry = &registry[id];
            let mut obj = serde_json::Map::new();
            obj.insert(
                "workDir".to_string(),
                Value::String(entry.work_dir.to_string_lossy().into_owned()),
            );
            if let Some(source_path) = &entry.source_path {
                obj.insert(
                    "sourcePath".to_string(),
                    Value::String(source_path.to_string_lossy().into_owned()),
                );
            }
            if let Some(saved_at) = entry.saved_at {
                obj.insert(
                    "savedAt".to_string(),
                    serde_json::Number::from_f64(saved_at)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                );
            }
            map.insert(id.clone(), Value::Object(obj));
        }
        let mut json = serde_json::to_string_pretty(&map)
            .map_err(|_| SlidraError::invalid("failed to write presentation registry data"))?;
        json.push('\n');

        let final_path = registry_path(home);
        let temp_path = home.join(format!(
            ".projects.json.{}.tmp",
            crate::id::random_hex_suffix()
        ));
        let write_result: std::io::Result<()> = (|| {
            std::fs::write(&temp_path, &json)?;
            std::fs::rename(&temp_path, &final_path)?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = std::fs::remove_file(&temp_path);
            return Err(SlidraError::invalid(
                "failed to write presentation registry data",
            ));
        }
        Ok(())
    }

    /// The real work directory a fresh presentation id should live at —
    /// `<home>/work/<id>/`. Callers create it; this function only computes
    /// the path.
    pub fn work_dir_for(home: &Path, id: &str) -> PathBuf {
        home.join("work").join(id)
    }

    /// The newest `mtime`, in milliseconds since the Unix epoch, of `dir`
    /// itself or anything nested inside it — used to snapshot "the work
    /// directory's content is known to match `sourcePath` byte-for-byte"
    /// at `open`/`pack` time (`RegistryEntry.saved_at`).
    pub fn max_mtime_in_directory(dir: &Path) -> SlidraResult<f64> {
        let metadata = std::fs::metadata(dir)
            .map_err(|_| SlidraError::invalid("failed to read presentation content timestamp"))?;
        let mut max = mtime_millis(&metadata)?;
        let entries = std::fs::read_dir(dir)
            .map_err(|_| SlidraError::invalid("failed to read presentation content timestamp"))?;
        for entry in entries {
            let entry = entry.map_err(|_| {
                SlidraError::invalid("failed to read presentation content timestamp")
            })?;
            let file_type = entry.file_type().map_err(|_| {
                SlidraError::invalid("failed to read presentation content timestamp")
            })?;
            let full_path = entry.path();
            if file_type.is_dir() {
                max = max.max(max_mtime_in_directory(&full_path)?);
            } else if file_type.is_file() {
                let file_metadata = std::fs::metadata(&full_path).map_err(|_| {
                    SlidraError::invalid("failed to read presentation content timestamp")
                })?;
                max = max.max(mtime_millis(&file_metadata)?);
            }
        }
        Ok(max)
    }

    fn mtime_millis(metadata: &std::fs::Metadata) -> SlidraResult<f64> {
        let modified = metadata
            .modified()
            .map_err(|_| SlidraError::invalid("failed to read presentation content timestamp"))?;
        let duration = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| SlidraError::invalid("failed to read presentation content timestamp"))?;
        Ok(duration.as_secs_f64() * 1000.0)
    }

    /// Resolves an opaque presentation id to its registry entry — the one
    /// place in this crate that does this. `SlidraError::NotFound` when
    /// `id` is not registered at all (as opposed to the registry itself
    /// being unreadable/corrupt, which is a plain `SlidraError`).
    pub fn lookup(id: &str) -> SlidraResult<RegistryEntry> {
        let home = resolve_home();
        let mut registry = read_registry(&home)?;
        registry
            .remove(id)
            .ok_or_else(|| SlidraError::not_found(format!("no presentation found for id: {id}")))
    }

    /// Test-only convenience: registers `id -> work_dir` with no
    /// `source_path`/`saved_at`, matching an older registry entry —
    /// used by sibling modules' `#[cfg(test)]` fixtures so each doesn't
    /// hand-roll `projects.json` JSON text.
    #[cfg(test)]
    pub(crate) fn register_for_test(home: &Path, id: &str, work_dir: &Path) {
        let mut registry = HashMap::new();
        registry.insert(
            id.to_string(),
            RegistryEntry {
                work_dir: work_dir.to_path_buf(),
                source_path: None,
                saved_at: None,
            },
        );
        write_registry(home, &registry).expect("test fixture write must succeed");
    }

    /// Serializes access to the `SLIDRA_HOME` env var across this
    /// crate's tests. `std::env::set_var`/`remove_var` mutate global process
    /// state; `cargo test` runs tests in one process by default, so any two
    /// tests that both read/write this env var without coordinating would
    /// race. Every test in this crate that sets `SLIDRA_HOME` (directly,
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
                "slidra-test-registry-{label}-{}",
                crate::id::random_hex_suffix()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        // The `projects.json` advisory lock. It exists because two
        // processes that each read the whole registry, change one entry and
        // write the whole map back will silently drop each other's changes
        // — temp-file + rename makes the file untearable, not race-free.

        #[test]
        fn registry_lock_uses_the_exact_filename_packages_server_also_hardcodes() {
            let home = temp_dir("lock-name");
            let seen = with_registry_lock(&home, || {
                Ok(std::fs::read_dir(&home)
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>())
            })
            .unwrap();
            assert_eq!(seen, vec![".projects.json.lock".to_string()]);
        }

        #[test]
        fn registry_lock_excludes_a_second_holder_while_the_first_is_inside() {
            let home = temp_dir("lock-excludes");
            with_registry_lock(&home, || {
                let blocked = with_registry_lock(&home, || Ok(()));
                assert!(blocked.is_err(), "a second holder must not get in");
                Ok(())
            })
            .unwrap();
        }

        #[test]
        fn registry_lock_is_released_when_the_body_fails() {
            let home = temp_dir("lock-release");
            let failed = with_registry_lock(&home, || {
                Err::<(), _>(SlidraError::invalid("body itself is broken"))
            });
            assert!(failed.is_err());
            assert!(!registry_lock_path(&home).exists());
            assert!(with_registry_lock(&home, || Ok(())).is_ok());
        }

        #[test]
        fn registry_lock_steals_a_lock_left_behind_by_a_dead_process() {
            let home = temp_dir("lock-steal");
            let lock = registry_lock_path(&home);
            let long_ago = std::time::SystemTime::now()
                - (LOCK_STALE_AFTER + std::time::Duration::from_secs(1));
            let handle = std::fs::File::create(&lock).unwrap();
            handle
                .set_times(std::fs::FileTimes::new().set_modified(long_ago))
                .unwrap();
            drop(handle);

            assert!(with_registry_lock(&home, || Ok(())).is_ok());
        }

        #[test]
        fn slidra_home_unset_vs_empty_string() {
            let _guard = ENV_LOCK.lock().unwrap();
            let previous = std::env::var_os("SLIDRA_HOME");
            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }

            // Unset: falls back to $HOME/.slidra.
            let home_env = std::env::var_os("HOME");
            let unset_result = resolve_home();
            if let Some(home) = &home_env {
                assert_eq!(unset_result, PathBuf::from(home).join(".slidra"));
            }

            // Empty string: TS's `??` only falls back on undefined/null, so
            // an empty string is used as-is, NOT treated as unset.
            unsafe {
                std::env::set_var("SLIDRA_HOME", "");
            }
            let empty_result = resolve_home();
            assert_eq!(empty_result, PathBuf::from(""));
            assert_ne!(empty_result, unset_result);

            match previous {
                Some(value) => unsafe { std::env::set_var("SLIDRA_HOME", value) },
                None => unsafe { std::env::remove_var("SLIDRA_HOME") },
            }
        }

        #[test]
        fn missing_projects_json_is_empty_registry_not_error() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("missing-file");
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }

            let err = lookup("whatever-id").unwrap_err();
            // NotFound (not InvalidRequest) proves the missing file was
            // treated as an empty registry, not a corrupted one.
            assert!(matches!(err, SlidraError::NotFound(_)));
            assert_eq!(err.message(), "no presentation found for id: whatever-id");

            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }

        #[test]
        fn malformed_projects_json_is_corrupted_error() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("malformed");
            std::fs::write(home.join("projects.json"), "{not valid json").unwrap();
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }

            let err = lookup("any-id").unwrap_err();
            assert!(matches!(err, SlidraError::InvalidRequest(_)));
            assert_eq!(err.message(), "presentation registry data is corrupted");

            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }

        #[test]
        fn registry_entry_missing_work_dir_is_corrupted_error() {
            let _guard = ENV_LOCK.lock().unwrap();
            let home = temp_dir("missing-workdir");
            std::fs::write(home.join("projects.json"), r#"{"abc123":{"foo":"bar"}}"#).unwrap();
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }

            let err = lookup("abc123").unwrap_err();
            assert_eq!(
                err.message(),
                "presentation registry data is corrupted: abc123"
            );

            unsafe {
                std::env::remove_var("SLIDRA_HOME");
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
                std::env::set_var("SLIDRA_HOME", &home);
            }

            let err = lookup("unknown-id").unwrap_err();
            assert!(matches!(err, SlidraError::NotFound(_)));
            assert_eq!(err.message(), "no presentation found for id: unknown-id");

            unsafe {
                std::env::remove_var("SLIDRA_HOME");
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
                std::env::set_var("SLIDRA_HOME", &home);
            }

            let entry = lookup("known-id").unwrap();
            assert_eq!(entry.work_dir, PathBuf::from("/tmp/known-work-dir"));

            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&home).ok();
        }
    }
}

/// Resolves an opaque presentation id to its real work directory.
pub fn resolve_work_dir(id: &str) -> SlidraResult<PathBuf> {
    Ok(registry::lookup(id)?.work_dir)
}

/// Lists the entry names of the virtual directory at `virtual_path` inside
/// the presentation identified by `id` — mirrors `workspace.ts`'s exported
/// `listPresentationEntries`. Used by `asset_import::resolve_conflict_free_filename`'s
/// callers to scan `assets/`/`assets/data/` for existing names.
///
/// Errors `NotFound` when the directory itself does not exist — ported
/// as-is from `virtual_fs::list_virtual_entries`'s existing behavior, which
/// is the same behavior `listVirtualEntries` has in TS. `assets/` is always
/// created by `new`'s scaffolding, so the media-asset path never hits this;
/// `assets/data/` is NOT pre-created, so a presentation's first `--as csv`
/// import errors here instead of importing — a pre-existing TS behavior
/// this port intentionally reproduces rather than silently "fixing" (see
/// plan §2.1 item 3; flagged in this ticket's delivery notes as a
/// pre-existing gap, not something introduced by this port).
pub fn list_presentation_entries(id: &str, virtual_path: &str) -> SlidraResult<Vec<String>> {
    let work_dir = resolve_work_dir(id)?;
    virtual_fs::list_virtual_entries(&work_dir, virtual_path)
}

#[cfg(test)]
mod write_path_tests {
    use super::*;
    use crate::errors::SlidraError;
    use std::path::Path;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-workspace-write-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn register(home: &Path, test_id: &str, work_dir: &Path) {
        let work_dir_json =
            serde_json::to_string(&work_dir.to_string_lossy().into_owned()).unwrap();
        let id_json = serde_json::to_string(test_id).unwrap();
        let json = format!(r#"{{{id_json}:{{"workDir":{work_dir_json}}}}}"#);
        std::fs::write(home.join("projects.json"), json).unwrap();
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, test_id: &str) -> Self {
            let guard = registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let work = temp_dir(&format!("{label}-work"));
            register(&home, test_id, &work);
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
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
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.work).ok();
        }
    }

    #[test]
    fn list_presentation_entries_lists_existing_directory() {
        let fixture = Fixture::new("list-entries", "pid-list-1");
        std::fs::create_dir_all(fixture.work.join("assets")).unwrap();
        std::fs::write(fixture.work.join("assets/a.png"), b"a").unwrap();
        std::fs::write(fixture.work.join("assets/b.png"), b"b").unwrap();

        let mut entries = list_presentation_entries("pid-list-1", "assets").unwrap();
        entries.sort();
        assert_eq!(entries, vec!["a.png".to_string(), "b.png".to_string()]);

        drop(fixture);
    }

    #[test]
    fn list_presentation_entries_missing_directory_is_not_found() {
        let fixture = Fixture::new("list-missing", "pid-list-2");
        let err = list_presentation_entries("pid-list-2", "assets/data").unwrap_err();
        assert!(matches!(err, SlidraError::NotFound(_)));

        drop(fixture);
    }
}
