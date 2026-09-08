//! Workspace read AND write paths. Originally (NOOP-278) ported from only
//! the READ half of `packages/core/src/workspace.ts` (home-dir resolution,
//! the registry read, id-to-workDir lookup) plus `project-json.ts` and
//! `virtual-fs.ts` in the `project`/`virtual_fs` submodules. NOOP-281/F5
//! adds this file's first writes: `write_presentation_file`,
//! `create_presentation_file`, `list_presentation_entries`, and
//! `assert_slide_path_listed` — every one of this ticket's 26 commands
//! writes through the first two. Still WRITES NOTHING to `projects.json`
//! itself, and no container packing/unpacking/format-version migration —
//! that remains a later ticket's.
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
//! - `fonts` — a presentation's embedded font book (see `fonts.rs`).
//! - `write_presentation_file(id, virtual_path, content) -> CoMotionResult<()>`
//!   — the single door every content-editing command in this crate writes
//!   through; see its own doc comment for the snapshot/commit/write
//!   ordering.
//! - `create_presentation_file(id, virtual_path, content: &[u8]) -> CoMotionResult<()>`
//!   — the creation counterpart (`asset import`): errors if `virtual_path`
//!   already exists, undo deletes it instead of restoring prior content.
//! - `list_presentation_entries(id, virtual_path) -> CoMotionResult<Vec<String>>`
//!   — `asset import`'s conflict-free-filename scan of `assets/`/`assets/data/`.
//! - `assert_slide_path_listed(work_dir, virtual_path) -> CoMotionResult<project::ProjectJson>`
//!   — confirms `virtual_path` is one of the presentation's declared slides
//!   or templates before any edit-path read/write of it is attempted.

pub mod fonts;
pub mod project;
pub mod virtual_fs;

use crate::errors::{CoMotionError, CoMotionResult};
use crate::history;
use std::path::{Path, PathBuf};

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

/// Confirms `virtual_path` is one of the presentation's declared slides
/// (`project.json`'s `slides` array) or `templates` entries — ported from
/// `workspace.ts`'s private `assertSlidePathListed`. Every edit-path
/// command in this crate calls this (via `resolve_virtual_file_path` first,
/// then this) before touching the slide file itself, so an edit aimed at
/// e.g. `project.json` is rejected before any read/write of it is
/// attempted. Returns the parsed `project.json` so a caller that also needs
/// it (none in this ticket yet) does not have to read it twice.
pub fn assert_slide_path_listed(
    work_dir: &Path,
    virtual_path: &str,
) -> CoMotionResult<project::ProjectJson> {
    let proj = project::read_project_json(work_dir)?;
    let templates = project::read_template_entries(&proj);
    let is_slide = proj.slides.iter().any(|slide| slide == virtual_path);
    let is_template = templates
        .iter()
        .any(|template| template.file == virtual_path);
    if !is_slide && !is_template {
        return Err(CoMotionError::invalid(format!(
            "不是投影片：{virtual_path}"
        )));
    }
    Ok(proj)
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
pub fn list_presentation_entries(id: &str, virtual_path: &str) -> CoMotionResult<Vec<String>> {
    let work_dir = resolve_work_dir(id)?;
    virtual_fs::list_virtual_entries(&work_dir, virtual_path)
}

/// The single door every content-writing command in this crate uses to
/// overwrite an EXISTING virtual file's content — ported from `workspace.ts`'s
/// `writePresentationFile`. Snapshots the file's current content into undo
/// history (via `history::stage_snapshot_entries`) and commits that undo
/// group durably (`history::commit_snapshot_entries`) *before* the content
/// write itself, matching the TS original's NOOP-337 ordering: nothing
/// makes the new content visible until the undo group that reverts it is
/// already durable. If the content write itself then fails, the commit is
/// unwound (`history::revert_committed_entries`) — a failed command must
/// not occupy an undo slot, and must not leave an orphan snapshot file
/// either.
pub fn write_presentation_file(id: &str, virtual_path: &str, content: &str) -> CoMotionResult<()> {
    let work_dir = resolve_work_dir(id)?;
    let real_path = virtual_fs::resolve_virtual_file_path(&work_dir, virtual_path)?;
    let entries = history::stage_snapshot_entries(id, &[virtual_path.to_string()])?;
    let commit = history::commit_snapshot_entries(id, entries.clone())?;
    match std::fs::write(&real_path, content.as_bytes()) {
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

/// The creation counterpart to `write_presentation_file` (`asset import`) —
/// ported from `workspace.ts`'s `createPresentationFile`. `virtual_path`
/// must not already exist. Undo for a created file deletes it instead of
/// restoring prior content (`history::stage_new_file_entry`), so it plugs
/// into the same `undo`/`redo` commands as every other write with no
/// bespoke asset-import undo logic.
///
/// Binary-safe: `content` is written and later restored as raw bytes, never
/// decoded as text — unlike `write_presentation_file`, which is only ever
/// used for this crate's own UTF-8 SVG/JSON content.
///
/// Unlike `write_presentation_file`, the commit happens AFTER the write
/// succeeds, not before: there is no prior visible content whose
/// undo-availability window matters here, only the new file itself, which
/// does not exist until the write succeeds.
pub fn create_presentation_file(
    id: &str,
    virtual_path: &str,
    content: &[u8],
) -> CoMotionResult<()> {
    let work_dir = resolve_work_dir(id)?;
    let already_exists = match virtual_fs::resolve_virtual_file_path(&work_dir, virtual_path) {
        Ok(_) => true,
        Err(CoMotionError::NotFound(_)) => false,
        Err(other) => return Err(other),
    };
    if already_exists {
        return Err(CoMotionError::invalid(format!(
            "檔案已存在：{virtual_path}"
        )));
    }

    let entries = vec![history::stage_new_file_entry(virtual_path)];
    let mut real_path = work_dir.clone();
    for segment in virtual_path
        .split('/')
        .filter(|segment| !segment.is_empty())
    {
        real_path.push(segment);
    }

    let write_result: std::io::Result<()> = (|| {
        if let Some(parent) = real_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&real_path, content)
    })();

    if write_result.is_err() {
        history::discard_snapshot_entries(id, &entries)?;
        // real_path is a real filesystem path (ADR-0004) — never quote it.
        return Err(CoMotionError::invalid(format!(
            "寫入檔案時發生錯誤：{virtual_path}"
        )));
    }

    let commit = history::commit_snapshot_entries(id, entries)?;
    history::finalize_committed_entries(id, &commit.pending_deletion_snapshot_ids)?;
    Ok(())
}

#[cfg(test)]
mod write_path_tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-workspace-write-{label}-{}",
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

    fn write_project_json(work_dir: &Path, slides: &[&str]) {
        let slides_json: Vec<String> = slides.iter().map(|s| format!("{s:?}")).collect();
        std::fs::write(
            work_dir.join("project.json"),
            format!(
                r#"{{"formatVersion":1,"name":"T","canvas":{{"width":1,"height":1}},"slides":[{}]}}"#,
                slides_json.join(",")
            ),
        )
        .unwrap();
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
    fn write_presentation_file_snapshots_before_overwriting_and_undo_restores_it() {
        let fixture = Fixture::new("write-roundtrip", "pid-write-1");
        write_project_json(&fixture.work, &["slides/001.svg"]);
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        std::fs::write(fixture.work.join("slides/001.svg"), "<svg>ORIGINAL</svg>").unwrap();

        write_presentation_file("pid-write-1", "slides/001.svg", "<svg>UPDATED</svg>").unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap(),
            "<svg>UPDATED</svg>"
        );

        let undo_result = history::undo("pid-write-1").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(
            std::fs::read_to_string(fixture.work.join("slides/001.svg")).unwrap(),
            "<svg>ORIGINAL</svg>"
        );

        drop(fixture);
    }

    #[test]
    fn write_presentation_file_rejects_a_path_not_listed_as_a_slide() {
        let fixture = Fixture::new("write-unlisted", "pid-write-2");
        write_project_json(&fixture.work, &["slides/001.svg"]);
        std::fs::write(fixture.work.join("project.json"), r#"{"formatVersion":1,"name":"T","canvas":{"width":1,"height":1},"slides":["slides/001.svg"]}"#).unwrap();

        let err = assert_slide_path_listed(&fixture.work, "project.json").unwrap_err();
        assert_eq!(err.message(), "不是投影片：project.json");

        drop(fixture);
    }

    #[test]
    fn create_presentation_file_rejects_an_already_existing_path() {
        let fixture = Fixture::new("create-exists", "pid-create-1");
        std::fs::create_dir_all(fixture.work.join("assets")).unwrap();
        std::fs::write(fixture.work.join("assets/photo.png"), b"existing").unwrap();

        let err =
            create_presentation_file("pid-create-1", "assets/photo.png", b"new bytes").unwrap_err();
        assert_eq!(err.message(), "檔案已存在：assets/photo.png");

        drop(fixture);
    }

    #[test]
    fn create_presentation_file_then_undo_deletes_the_created_file() {
        let fixture = Fixture::new("create-undo", "pid-create-2");
        std::fs::create_dir_all(fixture.work.join("assets")).unwrap();

        create_presentation_file("pid-create-2", "assets/new.png", b"\x89PNG\r\n\x1a\n").unwrap();
        let created_path = fixture.work.join("assets/new.png");
        assert_eq!(std::fs::read(&created_path).unwrap(), b"\x89PNG\r\n\x1a\n");

        let undo_result = history::undo("pid-create-2").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["assets/new.png".to_string()]
        );
        assert!(!created_path.exists());

        drop(fixture);
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
        assert!(matches!(err, CoMotionError::NotFound(_)));

        drop(fixture);
    }
}
