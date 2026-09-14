// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Per-deck advisory lock.
//!
//! Every `slidra` invocation that names a presentation holds this lock
//! for the lifetime of the process, so two concurrent invocations against
//! the same deck are serialised instead of racing on the same file. The
//! race is real: an agent that issues a dozen `effect add` calls for one
//! slide in parallel had two processes read-modify-write `slides/00N.svg`
//! at once and left a `<slidra:effects>` list the next command could not
//! parse.
//!
//! The lock file lives at `<SLIDRA_HOME>/locks/<fnv1a64(canonical deck
//! path)>.lock` — NOT inside the deck itself
//! (`spec/rfcs/0001-sqlite-container-format.md` decision 5): the deck's
//! directory must hold exactly one file once the process closes it (AC4),
//! so a coordination file can no longer live alongside it the way the old
//! `.slidra.lock` lived inside the work directory. Keying by the deck's
//! own canonical path (not the presentation id) is deliberate: two
//! different ids can resolve to the very same deck file (`open`ing the
//! same path twice mints two ids), and both must still serialise against
//! each other. `canonicalize()` falls back to the path as given when the
//! file cannot be stat'd (`new`/`open` never lock at all — see
//! `main.rs::hold_presentation_lock` — so every real caller here names an
//! already-existing deck).
//!
//! The lock is a file created with `create_new`, which is atomic on every
//! platform the CLI runs on and needs no extra dependency. A holder that
//! crashed leaves the file behind, so a lock older than `STALE_AFTER` is
//! treated as abandoned and removed.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::errors::{SlidraError, SlidraResult};

/// How long a waiter keeps retrying before giving up with an error.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);
/// Sleep between attempts. Commands are short (tens of milliseconds), so a
/// short poll keeps a queue of parallel calls flowing.
const RETRY_INTERVAL: Duration = Duration::from_millis(20);
/// A lock file older than this belongs to a process that died without
/// releasing it — no single command runs anywhere near this long.
const STALE_AFTER: Duration = Duration::from_secs(60);

/// RAII guard: the lock file exists exactly as long as this value lives.
#[derive(Debug)]
pub struct PresentationLock {
    path: PathBuf,
}

/// The lock file's path for `deck_path`, under `<SLIDRA_HOME>/locks/`.
fn lock_path_for(deck_path: &Path) -> PathBuf {
    let canonical = deck_path
        .canonicalize()
        .unwrap_or_else(|_| deck_path.to_path_buf());
    let hash = crate::id::fnv1a64(canonical.to_string_lossy().as_bytes());
    crate::workspace::resolve_home()
        .join("locks")
        .join(format!("{hash:016x}.lock"))
}

impl PresentationLock {
    /// Acquires the lock for `deck_path`, waiting for a concurrent holder
    /// to finish. Errors only when the wait exceeds `ACQUIRE_TIMEOUT` or
    /// `<SLIDRA_HOME>/locks/` cannot be written.
    pub fn acquire(deck_path: &Path) -> SlidraResult<Self> {
        let path = lock_path_for(deck_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| SlidraError::invalid("failed to create presentation lock file"))?;
        }
        let started = Instant::now();
        let mut removed_stale = false;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    // The content is informational (which process holds it);
                    // a failed write does not affect the lock itself.
                    let _ = write!(file, "{}", std::process::id());
                    return Ok(PresentationLock { path });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    if !removed_stale && is_stale(&path) {
                        // Remove once, then compete for it like everyone else;
                        // a second stale hit means someone else re-created it.
                        let _ = std::fs::remove_file(&path);
                        removed_stale = true;
                        continue;
                    }
                    if started.elapsed() >= ACQUIRE_TIMEOUT {
                        return Err(SlidraError::invalid(
                            "presentation is currently in use by another slidra command, wait timed out; please try again later",
                        ));
                    }
                    std::thread::sleep(RETRY_INTERVAL);
                }
                Err(_) => {
                    return Err(SlidraError::invalid(
                        "failed to create presentation lock file",
                    ));
                }
            }
        }
    }

    /// The lock file's path (tests).
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PresentationLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn is_stale(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        // Vanished between the failed create and now — the next attempt
        // will simply succeed.
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age >= STALE_AFTER)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        home: PathBuf,
        deck: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let guard = crate::workspace::registry::ENV_LOCK.lock().unwrap();
            let home = std::env::temp_dir().join(format!(
                "slidra-lock-{label}-home-{}-{}",
                std::process::id(),
                crate::id::random_hex_suffix()
            ));
            std::fs::create_dir_all(&home).unwrap();
            let deck = std::env::temp_dir().join(format!(
                "slidra-lock-{label}-deck-{}-{}.slidra",
                std::process::id(),
                crate::id::random_hex_suffix()
            ));
            std::fs::write(&deck, b"deck bytes").unwrap();
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
    fn acquire_creates_the_file_under_slidra_home_locks_and_drop_removes_it() {
        let fixture = Fixture::new("acquire");
        let lock_path = lock_path_for(&fixture.deck);
        {
            let lock = PresentationLock::acquire(&fixture.deck).unwrap();
            assert_eq!(lock.path(), lock_path);
            assert!(lock_path.starts_with(fixture.home.join("locks")));
            assert!(lock_path.exists());
        }
        assert!(!lock_path.exists(), "drop must release the lock");
        drop(fixture);
    }

    #[test]
    fn two_ids_resolving_to_the_same_canonical_deck_share_one_lock() {
        let fixture = Fixture::new("same-deck");
        // A different-looking path to the exact same file (via `..`) must
        // hash to the same lock file, since `canonicalize()` resolves both
        // to the identical real path — the "two ids, one deck" case.
        let alias = fixture
            .home
            .join("..")
            .join(fixture.home.file_name().unwrap())
            .join("..")
            .join(fixture.deck.file_name().unwrap());
        assert_eq!(lock_path_for(&fixture.deck), lock_path_for(&alias));
        drop(fixture);
    }

    #[test]
    fn a_second_holder_waits_until_the_first_releases() {
        let fixture = Fixture::new("wait");
        let first = PresentationLock::acquire(&fixture.deck).unwrap();
        let deck_for_thread = fixture.deck.clone();
        let waiter = std::thread::spawn(move || {
            let started = Instant::now();
            let lock = PresentationLock::acquire(&deck_for_thread).unwrap();
            drop(lock);
            started.elapsed()
        });
        std::thread::sleep(Duration::from_millis(150));
        drop(first);
        let waited = waiter.join().unwrap();
        assert!(
            waited >= Duration::from_millis(100),
            "waiter must have blocked on the first holder, waited {waited:?}"
        );
        drop(fixture);
    }

    #[test]
    fn a_stale_lock_is_removed_and_reacquired() {
        let fixture = Fixture::new("stale");
        let lock_path = lock_path_for(&fixture.deck);
        std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        std::fs::write(&lock_path, "dead").unwrap();
        let old = SystemTime::now() - STALE_AFTER - Duration::from_secs(5);
        let file = std::fs::File::options()
            .write(true)
            .open(&lock_path)
            .unwrap();
        file.set_modified(old).unwrap();
        drop(file);
        let started = Instant::now();
        let lock = PresentationLock::acquire(&fixture.deck).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a stale lock must not make the caller wait out the timeout"
        );
        drop(lock);
        assert!(!lock_path.exists());
        drop(fixture);
    }
}
