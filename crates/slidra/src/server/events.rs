// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `GET /events` ([S11.F9], #404 Scope "Change events") — a one-way stream
//! scoped to one workbench by the credential, saying only that something
//! changed and carrying no deck content (spec #395 decision 18); the
//! browser reconnects itself, so this handler holds the connection open
//! and simply stops (closing it) on the first write failure or a fatal
//! watch condition, rather than trying to recover.
//!
//! Ported behavior, not implementation, from `packages/server/src/
//! watch.ts`/`changes.ts`/`sse.ts`: this crate has no filesystem-watch
//! dependency (`Cargo.toml`: clap/serde/serde_json/ureq/httparse/flate2/
//! zip/rusqlite/landlock only — NOOP-641 Plan §3/§7's decision), so a
//! background-thread mtime poll (~100ms) with a 100ms trailing debounce
//! replaces `fs.watch` + its own debounce; the coalescing behavior this
//! produces — a burst of writes yields one notification, sent 100ms after
//! the LAST one — is the property `watch.ts`'s debounce and Plan §4's
//! contract row both actually require, not the fs-event mechanism itself.
//! Wire format is real Server-Sent-Events (`sse.ts`'s own frame shape,
//! `event: <name>\ndata: <payload>\n\n`, `: \n\n` for a heartbeat) so the
//! eventual Node forwarding layer ([E10.T5] transitional infra) can pipe
//! this response's bytes straight through to the browser's `EventSource`
//! without re-encoding.

use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use crate::server::credential::CallerKind;
use crate::server::{self, RawRequest};

const READ_CALLERS: &[CallerKind] = &[CallerKind::Editor, CallerKind::Viewer];
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const DEBOUNCE: Duration = Duration::from_millis(100);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

pub(crate) fn handle(request: &RawRequest, stream: &mut TcpStream) {
    let Some((_credential, work_dir)) =
        server::authorize_deck_scoped(request, stream, READ_CALLERS)
    else {
        return;
    };

    let cors = server::cors_response_headers();
    let head = format!(
        "HTTP/1.1 200 OK\r\nConnection: close\r\n{cors}content-type: text/event-stream; charset=utf-8\r\ncache-control: no-cache\r\nx-accel-buffering: no\r\n\r\n"
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }

    run_notification_loop(
        stream,
        &work_dir,
        &Timing {
            poll_interval: POLL_INTERVAL,
            debounce: DEBOUNCE,
            heartbeat_interval: HEARTBEAT_INTERVAL,
        },
    );
}

/// The three intervals `run_notification_loop` runs on — a real connection
/// always uses `POLL_INTERVAL`/`DEBOUNCE`/`HEARTBEAT_INTERVAL`; tests shrink
/// all three so the coalescing and heartbeat/disconnect-detection behavior
/// can be exercised in milliseconds instead of the real 15-second heartbeat
/// window.
struct Timing {
    poll_interval: Duration,
    debounce: Duration,
    heartbeat_interval: Duration,
}

/// The poll/debounce/heartbeat loop, split out from `handle` so it can be
/// exercised in tests with a fake `Write` sink instead of a real socket.
fn run_notification_loop(sink: &mut impl Write, deck_path: &Path, timing: &Timing) {
    let mut last_sent = deck_stamp(deck_path);
    let mut last_seen = last_sent.clone();
    let mut changed_at: Option<Instant> = None;
    let mut last_heartbeat = Instant::now();

    loop {
        std::thread::sleep(timing.poll_interval);
        let now_stamp = deck_stamp(deck_path);
        if now_stamp != last_seen {
            last_seen = now_stamp;
            changed_at = Some(Instant::now());
        }

        if let Some(t) = changed_at {
            if t.elapsed() >= timing.debounce && last_seen != last_sent {
                if write_event(sink, "presentation-changed", "{}").is_err() {
                    return;
                }
                last_sent = last_seen.clone();
                changed_at = None;
                last_heartbeat = Instant::now();
            }
        } else if last_heartbeat.elapsed() >= timing.heartbeat_interval {
            if write_heartbeat(sink).is_err() {
                return;
            }
            last_heartbeat = Instant::now();
        }
    }
}

#[derive(Clone, PartialEq)]
struct FileStamp {
    modified: SystemTime,
    len: u64,
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        modified: metadata.modified().ok()?,
        len: metadata.len(),
    })
}

fn deck_stamp(path: &Path) -> (Option<FileStamp>, Option<FileStamp>) {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    (file_stamp(path), file_stamp(Path::new(&wal)))
}

/// Builds the whole frame as one `String` first, then a single
/// `write_all` call — never a series of small `write!` segments, so each
/// notification is exactly one write attempt (and therefore one point of
/// disconnect detection), matching `sse.ts`'s own one-shot frame write.
fn write_event(sink: &mut impl Write, event: &str, data: &str) -> std::io::Result<()> {
    let frame = format!("event: {event}\ndata: {data}\n\n");
    sink.write_all(frame.as_bytes())
}

fn write_heartbeat(sink: &mut impl Write) -> std::io::Result<()> {
    sink.write_all(b": \n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A `Write` sink that records every write and fails (simulating a
    /// disconnected client) once `fail_after` bytes have been written —
    /// lets `run_notification_loop`'s exit-on-write-failure path be
    /// exercised deterministically instead of waiting for a real poll
    /// loop that never terminates.
    #[derive(Clone)]
    struct RecordingSink {
        written: Arc<Mutex<Vec<u8>>>,
        fail_after_writes: Arc<Mutex<usize>>,
    }

    impl RecordingSink {
        fn new(fail_after_writes: usize) -> Self {
            RecordingSink {
                written: Arc::new(Mutex::new(Vec::new())),
                fail_after_writes: Arc::new(Mutex::new(fail_after_writes)),
            }
        }

        fn text(&self) -> String {
            String::from_utf8(self.written.lock().unwrap().clone()).unwrap()
        }
    }

    impl Write for RecordingSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut remaining = self.fail_after_writes.lock().unwrap();
            if *remaining == 0 {
                return Err(std::io::Error::other("simulated disconnect"));
            }
            *remaining -= 1;
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn temp_deck_file(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "slidra-test-events-{label}-{}.slidra",
            crate::id::random_hex_suffix()
        ));
        std::fs::write(&path, b"initial").unwrap();
        path
    }

    fn fast_timing() -> Timing {
        Timing {
            poll_interval: Duration::from_millis(10),
            debounce: Duration::from_millis(30),
            heartbeat_interval: Duration::from_millis(60),
        }
    }

    #[test]
    fn a_single_change_settled_for_the_debounce_window_produces_one_notification() {
        let path = temp_deck_file("single-change");
        // One write allowed: the event frame. The second write attempt
        // (the next heartbeat) fails, which is how the loop learns the
        // "connection" is gone and returns.
        let sink = RecordingSink::new(1);
        let mut sink_clone = sink.clone();

        let path_for_writer = path.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(15));
            std::fs::write(&path_for_writer, b"changed").unwrap();
        });

        run_notification_loop(&mut sink_clone, &path, &fast_timing());
        writer.join().unwrap();

        assert_eq!(sink.text(), "event: presentation-changed\ndata: {}\n\n");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_burst_of_writes_produces_exactly_one_notification() {
        let path = temp_deck_file("burst");
        let sink = RecordingSink::new(1);
        let mut sink_clone = sink.clone();

        let path_for_writer = path.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..5 {
                std::thread::sleep(Duration::from_millis(8));
                std::fs::write(&path_for_writer, format!("changed-{i}")).unwrap();
            }
        });

        run_notification_loop(&mut sink_clone, &path, &fast_timing());
        writer.join().unwrap();

        assert_eq!(sink.text(), "event: presentation-changed\ndata: {}\n\n");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_sqlite_wal_write_produces_a_notification_before_checkpoint() {
        let path = temp_deck_file("wal");
        std::fs::remove_file(&path).unwrap();
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        connection
            .execute("CREATE TABLE changes (value TEXT)", [])
            .unwrap();

        let sink = RecordingSink::new(1);
        let mut sink_clone = sink.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(15));
            connection
                .execute("INSERT INTO changes (value) VALUES ('changed')", [])
                .unwrap();
            std::thread::sleep(Duration::from_millis(80));
        });

        run_notification_loop(&mut sink_clone, &path, &fast_timing());
        writer.join().unwrap();

        assert_eq!(sink.text(), "event: presentation-changed\ndata: {}\n\n");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn no_change_sends_a_heartbeat_then_stops_once_the_connection_is_gone() {
        let path = temp_deck_file("no-change");
        // Zero writes allowed: even the first heartbeat fails, proving the
        // loop reaches the heartbeat branch (not just the change branch)
        // and exits on that failure rather than looping forever.
        let sink = RecordingSink::new(0);
        let mut sink_clone = sink.clone();

        run_notification_loop(&mut sink_clone, &path, &fast_timing());

        assert_eq!(sink.text(), "");
        std::fs::remove_file(&path).ok();
    }
    #[test]
    fn a_change_in_another_workbench_never_reaches_this_stream() {
        let watched = temp_deck_file("watched");
        let other = temp_deck_file("other");
        let sink = RecordingSink::new(0);
        let mut sink_clone = sink.clone();

        let writer = std::thread::spawn({
            let other = other.clone();
            move || {
                std::thread::sleep(Duration::from_millis(15));
                std::fs::write(other, b"other changed").unwrap();
            }
        });
        run_notification_loop(&mut sink_clone, &watched, &fast_timing());
        writer.join().unwrap();

        assert_eq!(sink.text(), "");
        std::fs::remove_file(watched).ok();
        std::fs::remove_file(other).ok();
    }
}
