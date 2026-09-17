// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The local, temp-directory-backed `WorkbenchStore` implementation.
//!
//! Layout, under `<std::env::temp_dir()>/slidra-workbench-<random hex>/`:
//! - `heartbeat` — this session's pid, rewritten every `HEARTBEAT_INTERVAL`
//!   so its mtime tells `sweep_orphans` the session is still alive.
//! - `policy.json` — the bytes `open` was given, written as-is (opaque to
//!   this module; plan §7.7).
//! - `deck` — one line: the deck file's own canonical path. This is a
//!   *reference*, not a copy — the deck itself is always edited in place
//!   through `crate::workspace::virtual_fs`, never duplicated into this
//!   directory (AC "leaves the deck file's path, bytes and modification
//!   semantics untouched").
//! - `uploads/<UploadId>` / `uploads/<UploadId>.name` — an upload's bytes
//!   and its original file name, stored separately so the name is never
//!   part of the lookup path.
//! - `scratch/` — the agent's scratch area; only `prepare_scratch`/
//!   `remove_scratch` touch it through this module, everything else reads
//!   and writes it with ordinary file APIs via
//!   `scratch_dir_for_local_spawn` (plan §7.8 — deliberately not on
//!   `WorkbenchStore`).
//!
//! The directory's own random suffix is generated independently of
//! `WorkbenchId` (plan §7.3): if the two were the same value, a caller
//! holding only the id could reconstruct the real directory, breaking the
//! "no caller can derive a path from what the interface returns" guarantee.
//!
//! Cleanup after an abnormal exit does not depend on any launcher running a
//! separate step: `sweep_orphans` runs once at the top of every `open`
//! (plan §7.5), removing any `slidra-workbench-*` directory whose
//! `heartbeat` has not been touched for `ORPHAN_AFTER` — long enough that a
//! live session (which refreshes it every `HEARTBEAT_INTERVAL`) is never
//! mistaken for a dead one.
//!
//! Liveness is tracked by heartbeat mtime, not a pid check: this crate's
//! fixed dependency budget has no `libc`, and `/proc`-based liveness checks
//! are not portable (plan §7.4).

use super::{UploadId, WorkbenchId, WorkbenchStore, validate_upload_file_name};
use crate::errors::{SlidraError, SlidraResult};
use crate::workspace::virtual_fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

const WORKBENCH_DIR_PREFIX: &str = "slidra-workbench-";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const ORPHAN_AFTER: Duration = Duration::from_secs(10 * 60);

/// A workbench backed by a directory under the local temp location. See
/// this file's own doc comment for the layout.
#[derive(Debug)]
pub struct LocalWorkbench {
    id: WorkbenchId,
    root: PathBuf,
    deck_path: PathBuf,
    scratch_dir: PathBuf,
    heartbeat_stop: Arc<AtomicBool>,
}

impl LocalWorkbench {
    /// Opens `deck_path`, creating a fresh workbench directory holding
    /// `policy` and a reference to the deck's own canonical path.
    /// `SlidraError::NotFound` if `deck_path` does not exist — and in that
    /// case no directory is created at all, the one representation of "no
    /// deck" this type has (plan §4/A1). `open` does not otherwise inspect
    /// the deck file's contents or format; validating it is a real
    /// `.slidra` container is `crate::deck`'s job, not this one's.
    pub fn open(deck_path: &Path, policy: &[u8]) -> SlidraResult<Self> {
        // Best-effort: a sweep failure (e.g. an unreadable temp dir) must
        // not block opening a workbench that has nothing to do with it.
        let _ = sweep_orphans();

        if std::fs::metadata(deck_path).is_err() {
            return Err(SlidraError::not_found(format!(
                "deck file not found: {}",
                deck_path.display()
            )));
        }
        let canonical_deck = deck_path
            .canonicalize()
            .unwrap_or_else(|_| deck_path.to_path_buf());

        let root = std::env::temp_dir().join(format!(
            "{WORKBENCH_DIR_PREFIX}{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(root.join("uploads"))
            .map_err(|_| SlidraError::invalid("failed to create workbench directory"))?;

        std::fs::write(root.join("policy.json"), policy)
            .map_err(|_| SlidraError::invalid("failed to write workbench policy"))?;
        std::fs::write(
            root.join("deck"),
            canonical_deck.to_string_lossy().as_bytes(),
        )
        .map_err(|_| SlidraError::invalid("failed to write workbench deck reference"))?;

        let heartbeat_path = root.join("heartbeat");
        write_heartbeat(&heartbeat_path)?;

        let heartbeat_stop = Arc::new(AtomicBool::new(false));
        spawn_heartbeat_thread(heartbeat_path, heartbeat_stop.clone());

        Ok(LocalWorkbench {
            id: WorkbenchId::generate(),
            scratch_dir: root.join("scratch"),
            root,
            deck_path: canonical_deck,
            heartbeat_stop,
        })
    }

    /// The scratch area's real path, for the local launcher to spawn an
    /// agent process into and this module's own tests — deliberately not
    /// part of `WorkbenchStore` (plan §7.8): nothing holding only a
    /// `&dyn WorkbenchStore` can reach this. Not itself a guarantee the
    /// directory exists; call `prepare_scratch` first.
    pub fn scratch_dir_for_local_spawn(&self) -> &Path {
        &self.scratch_dir
    }
}

impl WorkbenchStore for LocalWorkbench {
    fn id(&self) -> &WorkbenchId {
        &self.id
    }

    fn read_deck_file(&self, virtual_path: &str) -> SlidraResult<Vec<u8>> {
        virtual_fs::read_virtual_file_bytes(&self.deck_path, virtual_path)
    }

    fn write_deck_file(&self, virtual_path: &str, content: &[u8]) -> SlidraResult<()> {
        virtual_fs::write_existing_file(&self.deck_path, virtual_path, content)
    }

    fn create_deck_file(&self, virtual_path: &str, content: &[u8]) -> SlidraResult<()> {
        virtual_fs::create_new_file(&self.deck_path, virtual_path, content)
    }

    fn delete_deck_file(&self, virtual_path: &str) -> SlidraResult<()> {
        virtual_fs::delete_file(&self.deck_path, virtual_path)
    }

    fn list_deck_entries(&self, virtual_path: &str) -> SlidraResult<Vec<String>> {
        virtual_fs::list_virtual_entries(&self.deck_path, virtual_path)
    }

    fn put_upload(&self, file_name: &str, bytes: &[u8]) -> SlidraResult<UploadId> {
        validate_upload_file_name(file_name)?;
        let id = UploadId::generate();
        let uploads_dir = self.root.join("uploads");
        std::fs::write(uploads_dir.join(id.as_str()), bytes)
            .map_err(|_| SlidraError::invalid("failed to write upload"))?;
        std::fs::write(uploads_dir.join(format!("{}.name", id.as_str())), file_name)
            .map_err(|_| SlidraError::invalid("failed to write upload"))?;
        Ok(id)
    }

    fn read_upload(&self, id: &UploadId) -> SlidraResult<Vec<u8>> {
        std::fs::read(self.root.join("uploads").join(id.as_str()))
            .map_err(|_| SlidraError::not_found(format!("upload not found: {id}")))
    }

    fn upload_file_name(&self, id: &UploadId) -> SlidraResult<String> {
        std::fs::read_to_string(
            self.root
                .join("uploads")
                .join(format!("{}.name", id.as_str())),
        )
        .map_err(|_| SlidraError::not_found(format!("upload not found: {id}")))
    }

    fn prepare_scratch(&self) -> SlidraResult<()> {
        std::fs::create_dir_all(&self.scratch_dir)
            .map_err(|_| SlidraError::invalid("failed to prepare workbench scratch directory"))
    }

    fn remove_scratch(&self) -> SlidraResult<()> {
        match std::fs::remove_dir_all(&self.scratch_dir) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(SlidraError::invalid(
                "failed to remove workbench scratch directory",
            )),
        }
    }
}

impl Drop for LocalWorkbench {
    fn drop(&mut self) {
        self.heartbeat_stop.store(true, Ordering::Relaxed);
        // Best-effort: the directory may already be gone (plan §4, "removed
        // externally then Drop -> no error").
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write_heartbeat(path: &Path) -> SlidraResult<()> {
    let mut file = std::fs::File::create(path)
        .map_err(|_| SlidraError::invalid("failed to write workbench heartbeat"))?;
    write!(file, "{}", std::process::id())
        .map_err(|_| SlidraError::invalid("failed to write workbench heartbeat"))?;
    Ok(())
}

/// Refreshes `heartbeat_path`'s mtime every `HEARTBEAT_INTERVAL` until
/// `stop` is set, in 100ms steps so `Drop` never has to wait out a full
/// interval to signal it. The `JoinHandle` is deliberately discarded —
/// `Drop` sets `stop` and returns without joining; the thread notices and
/// exits on its own, and a failed write after the directory is already
/// gone is silently ignored (the same best-effort stance as everything
/// else in this file's shutdown path).
fn spawn_heartbeat_thread(heartbeat_path: PathBuf, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let mut waited = Duration::ZERO;
            while waited < HEARTBEAT_INTERVAL {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let step = Duration::from_millis(100).min(HEARTBEAT_INTERVAL - waited);
                std::thread::sleep(step);
                waited += step;
            }
            let _ = write_heartbeat(&heartbeat_path);
        }
    });
}

/// Removes every `slidra-workbench-*` directory under the local temp
/// location whose `heartbeat` (or, absent that, the directory itself) has
/// not been touched for `ORPHAN_AFTER` — the half of the lifecycle
/// contract that runs with no live `LocalWorkbench` around to call it
/// (called automatically at the top of every `open`; plan §7.5). Returns
/// the number of directories removed. Errors reading the temp location
/// itself are swallowed (`Ok(0)`) — this is opportunistic cleanup, not a
/// required precondition for anything.
pub fn sweep_orphans() -> SlidraResult<usize> {
    let base = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(WORKBENCH_DIR_PREFIX) || !path.is_dir() {
            continue;
        }
        if is_orphaned(&path) && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn is_orphaned(root: &Path) -> bool {
    let reference = root
        .join("heartbeat")
        .metadata()
        .and_then(|m| m.modified())
        .or_else(|_| root.metadata().and_then(|m| m.modified()));
    match reference {
        Ok(modified) => SystemTime::now()
            .duration_since(modified)
            .map(|age| age >= ORPHAN_AFTER)
            .unwrap_or(false),
        // Neither the heartbeat file nor the directory itself could be
        // stat'd (vanished concurrently) — leave it for the next sweep
        // rather than guess.
        Err(_) => false,
    }
}

#[cfg(test)]
impl LocalWorkbench {
    /// Test-only introspection of the real directory — never exposed
    /// outside `#[cfg(test)]`, so it cannot widen this module's path-leak
    /// surface (plan §7.8's stance applied to a second accessor).
    pub(crate) fn root_for_test(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::SlidraError;
    use std::time::SystemTime;

    fn temp_deck(label: &str) -> PathBuf {
        crate::deck::build_test_deck(label, &[("slides/001.svg", b"<svg/>")])
    }

    #[test]
    fn open_creates_a_workbench_directory_under_the_temp_location() {
        let deck = temp_deck("lifecycle-create");
        let wb = LocalWorkbench::open(&deck, b"policy-bytes").unwrap();
        let root = wb.root_for_test().to_path_buf();
        assert!(root.starts_with(std::env::temp_dir()));
        assert!(root.join("policy.json").is_file());
        assert!(root.join("deck").is_file());
        assert!(root.join("heartbeat").is_file());
        assert_eq!(
            std::fs::read(root.join("policy.json")).unwrap(),
            b"policy-bytes"
        );
        drop(wb);
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn drop_removes_the_workbench_directory() {
        let deck = temp_deck("lifecycle-drop");
        let wb = LocalWorkbench::open(&deck, b"policy").unwrap();
        let root = wb.root_for_test().to_path_buf();
        assert!(root.exists());
        drop(wb);
        assert!(!root.exists(), "drop must remove the workbench directory");
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn open_on_a_nonexistent_deck_path_is_not_found_and_creates_no_directory() {
        let missing = std::env::temp_dir().join(format!(
            "slidra-test-missing-deck-{}.slidra",
            crate::id::random_hex_suffix()
        ));
        let before: std::collections::HashSet<_> = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();

        let err = LocalWorkbench::open(&missing, b"policy").unwrap_err();
        assert!(matches!(err, SlidraError::NotFound(_)));

        let after: std::collections::HashSet<_> = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        let new_entries: Vec<_> = after.difference(&before).collect();
        assert!(
            new_entries.is_empty(),
            "open() on a missing deck must create no directory, found: {new_entries:?}"
        );
    }

    #[test]
    fn sweep_orphans_removes_a_stale_orphan_and_keeps_a_fresh_one() {
        let base = std::env::temp_dir();
        let stale = base.join(format!(
            "{WORKBENCH_DIR_PREFIX}test-stale-{}",
            crate::id::random_hex_suffix()
        ));
        let fresh = base.join(format!(
            "{WORKBENCH_DIR_PREFIX}test-fresh-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        write_heartbeat(&stale.join("heartbeat")).unwrap();
        write_heartbeat(&fresh.join("heartbeat")).unwrap();
        let old = SystemTime::now() - ORPHAN_AFTER - Duration::from_secs(5);
        let stale_heartbeat = std::fs::File::options()
            .write(true)
            .open(stale.join("heartbeat"))
            .unwrap();
        stale_heartbeat.set_modified(old).unwrap();
        drop(stale_heartbeat);

        sweep_orphans().unwrap();

        assert!(!stale.exists(), "a stale orphan must be removed");
        assert!(fresh.exists(), "a fresh workbench must be kept");
        std::fs::remove_dir_all(&fresh).ok();
    }

    #[test]
    fn distinct_local_workbenches_get_distinct_ids_and_directory_suffixes_not_derived_from_each_other()
     {
        let deck = temp_deck("guard-dirname");
        let a = LocalWorkbench::open(&deck, b"policy").unwrap();
        let b = LocalWorkbench::open(&deck, b"policy").unwrap();

        assert_ne!(a.id(), b.id());
        assert_ne!(a.root_for_test(), b.root_for_test());
        assert!(
            !a.root_for_test()
                .to_string_lossy()
                .contains(a.id().as_str()),
            "the directory name must not embed the workbench id"
        );
        assert!(
            !b.root_for_test()
                .to_string_lossy()
                .contains(b.id().as_str())
        );

        drop(a);
        drop(b);
        std::fs::remove_file(&deck).ok();
    }
}
