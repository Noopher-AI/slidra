// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The editing-lock mutual-exclusion floor, moved into the crate
//! (NOOP-641 Plan §裁示1): once this ticket lands, Node is no longer a
//! write path at all, so the floor has to live where writes actually
//! happen — `POST /call`'s dispatch (`handle_call`, `mod.rs`) — to mean
//! anything. Ported behavior, not implementation, from
//! `packages/server/src/editing-lock.ts`: scope changes from "one
//! process, one presentation" to per-workbench (keyed by
//! `credential.workbench_id`, still today's presentation id — Plan
//! §裁示1: "本輪只搬機制不換 key"), and the wait a Node `Promise`
//! resolved is now a blocking `Condvar` wait (thread-per-connection, so
//! blocking the handler thread is the direct equivalent).
//!
//! The split editor calls these routes directly with its workbench credential.
//! Node still mirrors the decision only inside the transitional combined
//! `startServe` harness, where legacy tests need the old event plumbing.

use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::server::credential::CallerKind;
use crate::server::{self, RawRequest};

/// Upper bound on a human lease with no renewal — not UX, purely so a
/// closed tab mid-drag cannot wedge the agent out forever (mirrors
/// `editing-lock.ts`'s `HUMAN_LEASE_MAX_MS`).
const HUMAN_LEASE_MAX: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockState {
    Idle,
    Human,
    Agent,
}

struct Entry {
    state: LockState,
    human_lease_deadline: Option<Instant>,
}

impl Default for Entry {
    fn default() -> Self {
        Entry {
            state: LockState::Idle,
            human_lease_deadline: None,
        }
    }
}

static LOCKS: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);
static WAKE: Condvar = Condvar::new();

fn with_locks<T>(body: impl FnOnce(&mut HashMap<String, Entry>) -> T) -> T {
    let mut guard = LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    body(map)
}

/// A human lease that has run past its deadline with no renewal reverts to
/// idle the moment anything next looks at it — same effect `endHumanEdit()`
/// has, per `editing-lock.ts`'s own comment on the 5s timer firing
/// naturally.
fn expire_if_stale(entry: &mut Entry) {
    if entry.state == LockState::Human {
        if let Some(deadline) = entry.human_lease_deadline {
            if Instant::now() >= deadline {
                entry.state = LockState::Idle;
                entry.human_lease_deadline = None;
            }
        }
    }
}

/// `beginHumanEdit()`: refuses while the agent holds the floor; otherwise
/// (re)arms a 5s lease — a renewal, same as calling it again while already
/// `Human`.
pub(crate) fn begin_human_edit(workbench_id: &str) -> Result<(), ()> {
    with_locks(|locks| {
        let entry = locks.entry(workbench_id.to_string()).or_default();
        expire_if_stale(entry);
        if entry.state == LockState::Agent {
            return Err(());
        }
        entry.state = LockState::Human;
        entry.human_lease_deadline = Some(Instant::now() + HUMAN_LEASE_MAX);
        Ok(())
    })
}

/// `endHumanEdit()`: a no-op unless currently `Human` — an extra `end` is
/// not a mistake.
pub(crate) fn end_human_edit(workbench_id: &str) {
    let mut guard = LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(entry) = map.get_mut(workbench_id) {
        if entry.state == LockState::Human {
            entry.state = LockState::Idle;
            entry.human_lease_deadline = None;
            drop(guard);
            WAKE.notify_all();
        }
    }
}

/// `acquireAgent()`: blocks while a human lease is active, waking as soon
/// as it ends or expires, then claims the floor. Idempotent — a turn that
/// already holds `Agent` returns immediately.
pub(crate) fn acquire_agent(workbench_id: &str) {
    let mut guard = LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    loop {
        let map = guard.get_or_insert_with(HashMap::new);
        let entry = map.entry(workbench_id.to_string()).or_default();
        expire_if_stale(entry);
        if entry.state != LockState::Human {
            entry.state = LockState::Agent;
            return;
        }
        let wait_for = entry
            .human_lease_deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .filter(|d| !d.is_zero())
            .unwrap_or(Duration::from_millis(50));
        let (next_guard, _timeout) =
            WAKE.wait_timeout(guard, wait_for)
                .unwrap_or_else(|poisoned| {
                    let (g, t) = poisoned.into_inner();
                    (g, t)
                });
        guard = next_guard;
    }
}

/// `releaseAgent()`: a no-op unless currently `Agent`.
pub(crate) fn release_agent(workbench_id: &str) {
    let mut guard = LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(entry) = map.get_mut(workbench_id) {
        if entry.state == LockState::Agent {
            entry.state = LockState::Idle;
            drop(guard);
            WAKE.notify_all();
        }
    }
}

/// `getState() === "agent"` — the one check `handle_call`'s dispatch gate
/// and `GET /editing` both need.
pub(crate) fn is_frozen(workbench_id: &str) -> bool {
    with_locks(|locks| {
        let entry = locks.entry(workbench_id.to_string()).or_default();
        expire_if_stale(entry);
        entry.state == LockState::Agent
    })
}

const EDITOR_ONLY: &[CallerKind] = &[CallerKind::Editor];
const AGENT_ONLY: &[CallerKind] = &[CallerKind::Agent];
const READ_CALLERS: &[CallerKind] = &[CallerKind::Editor, CallerKind::Viewer];

pub(crate) fn handle_begin(request: &RawRequest, stream: &mut TcpStream) {
    let Some((credential, _)) = server::authorize_deck_scoped(request, stream, EDITOR_ONLY) else {
        return;
    };
    match begin_human_edit(&credential.workbench_id) {
        Ok(()) => server::write_json_response(stream, &serde_json::json!({ "ok": true })),
        Err(()) => {
            server::write_json_error(stream, 409, "The agent is currently editing, please wait.")
        }
    }
}

pub(crate) fn handle_end(request: &RawRequest, stream: &mut TcpStream) {
    let Some((credential, _)) = server::authorize_deck_scoped(request, stream, EDITOR_ONLY) else {
        return;
    };
    end_human_edit(&credential.workbench_id);
    server::write_json_response(stream, &serde_json::json!({ "ok": true }));
}

pub(crate) fn handle_status(request: &RawRequest, stream: &mut TcpStream) {
    let Some((credential, _)) = server::authorize_deck_scoped(request, stream, READ_CALLERS) else {
        return;
    };
    server::write_json_response(
        stream,
        &serde_json::json!({ "frozen": is_frozen(&credential.workbench_id) }),
    );
}

pub(crate) fn handle_agent_begin(request: &RawRequest, stream: &mut TcpStream) {
    let Some((credential, _)) = server::authorize_deck_scoped(request, stream, AGENT_ONLY) else {
        return;
    };
    acquire_agent(&credential.workbench_id);
    server::write_json_response(stream, &serde_json::json!({ "ok": true }));
}

pub(crate) fn handle_agent_end(request: &RawRequest, stream: &mut TcpStream) {
    let Some((credential, _)) = server::authorize_deck_scoped(request, stream, AGENT_ONLY) else {
        return;
    };
    release_agent(&credential.workbench_id);
    server::write_json_response(stream, &serde_json::json!({ "ok": true }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_id() -> String {
        format!("test-lock-{}", crate::id::random_hex_suffix())
    }

    #[test]
    fn idle_by_default_and_after_no_activity() {
        let id = fresh_id();
        assert!(!is_frozen(&id));
    }

    #[test]
    fn human_then_agent_then_idle_round_trip() {
        let id = fresh_id();
        assert!(begin_human_edit(&id).is_ok());
        assert!(!is_frozen(&id));
        end_human_edit(&id);
        acquire_agent(&id);
        assert!(is_frozen(&id));
        release_agent(&id);
        assert!(!is_frozen(&id));
    }

    #[test]
    fn begin_human_edit_refused_while_agent_holds_it() {
        let id = fresh_id();
        acquire_agent(&id);
        assert!(begin_human_edit(&id).is_err());
        release_agent(&id);
        assert!(begin_human_edit(&id).is_ok());
    }

    #[test]
    fn end_human_edit_is_a_noop_when_not_human() {
        let id = fresh_id();
        end_human_edit(&id); // never began — must not panic or change state
        assert!(!is_frozen(&id));
    }

    #[test]
    fn release_agent_is_a_noop_when_not_agent() {
        let id = fresh_id();
        release_agent(&id);
        assert!(!is_frozen(&id));
    }

    #[test]
    fn acquire_agent_waits_for_a_released_human_lease() {
        let id = fresh_id();
        assert!(begin_human_edit(&id).is_ok());
        let waiter_id = id.clone();
        let handle = std::thread::spawn(move || {
            acquire_agent(&waiter_id);
        });
        std::thread::sleep(Duration::from_millis(30));
        end_human_edit(&id);
        handle.join().unwrap();
        assert!(is_frozen(&id));
        release_agent(&id);
    }
    #[test]
    fn different_workbenches_do_not_exclude_each_other() {
        let first = fresh_id();
        let second = fresh_id();
        acquire_agent(&first);
        assert!(is_frozen(&first));
        assert!(!is_frozen(&second));
        assert!(begin_human_edit(&second).is_ok());
        end_human_edit(&second);
        release_agent(&first);
    }
}
