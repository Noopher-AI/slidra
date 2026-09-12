//! Per-presentation advisory lock.
//!
//! Every `slidra` invocation that names a presentation holds this lock
//! for the lifetime of the process, so two concurrent invocations against
//! the same work directory are serialised instead of racing on the same
//! file. The race is real: an agent that issues a dozen `effect add` calls
//! for one slide in parallel had two processes read-modify-write
//! `slides/00N.svg` at once and left a `<slidra:effects>` list the next
//! command could not parse.
//!
//! The lock is a file (`.slidra.lock`) created with `create_new`, which
//! is atomic on every platform the CLI runs on and needs no extra
//! dependency. A holder that crashed leaves the file behind, so a lock
//! older than `STALE_AFTER` is treated as abandoned and removed. The file
//! is invisible to `ls`/`cat` (`virtual_fs` skips it) and never packed
//! into a `.slidra` (`container::collect_files` skips it).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::errors::{SlidraError, SlidraResult};

/// The lock file's name inside a presentation's work directory.
pub const LOCK_FILE_NAME: &str = ".slidra.lock";

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

impl PresentationLock {
    /// Acquires the lock for `work_dir`, waiting for a concurrent holder to
    /// finish. Errors only when the wait exceeds `ACQUIRE_TIMEOUT` or the
    /// work directory cannot be written.
    pub fn acquire(work_dir: &Path) -> SlidraResult<Self> {
        let path = work_dir.join(LOCK_FILE_NAME);
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
                            "簡報正被另一個 slidra 命令使用中，等待逾時；請稍後再試",
                        ));
                    }
                    std::thread::sleep(RETRY_INTERVAL);
                }
                Err(_) => {
                    return Err(SlidraError::invalid("無法建立簡報的鎖定檔"));
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

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-lock-{label}-{}-{}",
            std::process::id(),
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquire_creates_the_file_and_drop_removes_it() {
        let dir = temp_dir("acquire");
        let lock_path = dir.join(LOCK_FILE_NAME);
        {
            let lock = PresentationLock::acquire(&dir).unwrap();
            assert_eq!(lock.path(), lock_path);
            assert!(lock_path.exists());
        }
        assert!(!lock_path.exists(), "drop must release the lock");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_holder_waits_until_the_first_releases() {
        let dir = temp_dir("wait");
        let first = PresentationLock::acquire(&dir).unwrap();
        let dir_for_thread = dir.clone();
        let waiter = std::thread::spawn(move || {
            let started = Instant::now();
            let lock = PresentationLock::acquire(&dir_for_thread).unwrap();
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
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stale_lock_is_removed_and_reacquired() {
        let dir = temp_dir("stale");
        let lock_path = dir.join(LOCK_FILE_NAME);
        std::fs::write(&lock_path, "dead").unwrap();
        let old = SystemTime::now() - STALE_AFTER - Duration::from_secs(5);
        let file = std::fs::File::options()
            .write(true)
            .open(&lock_path)
            .unwrap();
        file.set_modified(old).unwrap();
        drop(file);
        let started = Instant::now();
        let lock = PresentationLock::acquire(&dir).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a stale lock must not make the caller wait out the timeout"
        );
        drop(lock);
        assert!(!lock_path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
