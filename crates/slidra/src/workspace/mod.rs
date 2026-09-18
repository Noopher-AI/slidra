// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Workspace read AND write paths: home-dir resolution, runtime
//! id-to-deck-path lookup, project-json and virtual-fs logic in the
//! `project`/`virtual_fs` submodules. `write.rs` holds the content-write doors
//! (`assert_slide_path_listed`, `write_presentation_file` and friends,
//! plus `require_slide` and runtime-scoped clipboard access).
//! The SQLite container itself lives in `deck.rs`; legacy ZIP reading
//! lives in `container.rs`. `list_presentation_entries` (`asset import`'s
//! conflict-free-filename scan) is added directly to this file, and a
//! `fonts` submodule for a presentation's embedded font book — every other
//! write this crate's commands need (`write_presentation_file`/
//! `create_presentation_file`/`assert_slide_path_listed`/`require_slide`)
//! reuses `write.rs`'s existing doors rather than adding its own.
//!
//! A presentation id resolves to the `.slidra` deck FILE itself — there is
//! no separate work directory any more (`spec/rfcs/0001-sqlite-container-format.md`):
//! `open <path>` operates on `<path>` in place (migrating it to SQLite
//! first if it is still a legacy ZIP). The deck-server runtime owns the
//! ephemeral id-to-path association; it is never persisted under
//! `SLIDRA_HOME`.
//!
//! Public API:
//! - `resolve_home() -> PathBuf` — `SLIDRA_HOME`, defaulting to
//!   `$HOME/.slidra`. Re-reads the env var on every call (never cached),
//!   matching the TS original's stated reason: tests point it at a fresh
//!   temp dir per case.
//! - `resolve_work_dir(id) -> SlidraResult<PathBuf>` — the one place an
//!   opaque presentation id becomes a real deck file path.
//!   `SlidraError::NotFound` when `id` is not registered. Kept under its
//!   original name (not renamed to "resolve_deck_path") to avoid a
//!   crate-wide rename churning every one of its ~90 call sites for a
//!   symbol whose contract — "the real path this id's content lives at" —
//!   has not changed, only what that path now points to (a file, not a
//!   directory).
//! - `project` — `project.json` read/parse/validate/write (see `project.rs`).
//! - `virtual_fs` — virtual path resolution within a deck (see
//!   `virtual_fs.rs`).
//! - `fonts` — a presentation's embedded font book (see `fonts.rs`).
//! - `write` — `assert_slide_path_listed`/`write_presentation_file`/
//!   `require_slide` and clipboard access (see `write.rs`).
//! - `list_presentation_entries(id, virtual_path) -> SlidraResult<Vec<String>>`
//!   — `asset import`'s conflict-free-filename scan of `assets/`/`assets/data/`.

pub mod fonts;
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
/// `pub(crate)`: `server::deck_store`'s own default-deck-folder fallback
/// (`~/Slidra`, mirroring `storage/deck-folder.ts`'s `defaultDeckFolder`)
/// needs the real OS home directory too, distinct from `resolve_home`'s
/// `SLIDRA_HOME` (which can point at a test's temp dir) — reusing this
/// rather than a second `$HOME`-or-`/` fallback.
pub(crate) fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Resolves an opaque presentation id to its real deck file path.
pub(crate) fn resolve_work_dir(id: &str) -> SlidraResult<PathBuf> {
    crate::workbench::runtime::resolve_deck_path(id)
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
    use crate::workbench::runtime;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-workspace-write-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fixture {
        home: PathBuf,
        deck: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, test_id: &str, files: &[(&str, &[u8])]) -> Self {
            let guard = runtime::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let deck = crate::deck::build_test_deck(label, files);
            runtime::register_for_test(&home, test_id, &deck);
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            Fixture {
                home,
                deck,
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
            std::fs::remove_file(&self.deck).ok();
        }
    }

    #[test]
    fn list_presentation_entries_lists_existing_directory() {
        let fixture = Fixture::new(
            "list-entries",
            "pid-list-1",
            &[("assets/a.png", b"a"), ("assets/b.png", b"b")],
        );

        let mut entries = list_presentation_entries("pid-list-1", "assets").unwrap();
        entries.sort();
        assert_eq!(entries, vec!["a.png".to_string(), "b.png".to_string()]);

        drop(fixture);
    }

    #[test]
    fn list_presentation_entries_missing_directory_is_not_found() {
        let fixture = Fixture::new("list-missing", "pid-list-2", &[]);
        let err = list_presentation_entries("pid-list-2", "assets/data").unwrap_err();
        assert!(matches!(err, SlidraError::NotFound(_)));

        drop(fixture);
    }
}
