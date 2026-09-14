// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Undo/redo for presentation content. Ported from
//! `packages/core/src/history.ts`, full file. The previous ticket ported
//! only the read/apply half (`stack.json`/`snapshots/` storage, the
//! `undo`/`redo` commands) because the write-path staging API
//! (`stageSnapshotEntries`/`commitSnapshotEntries`/`discardSnapshotEntries`/
//! `finalizeCommittedEntries`/`revertCommittedEntries`/`beginHistoryGroup`/
//! `endHistoryGroup`/`recordSnapshot`) had no caller yet. [E4.T5]'s 27
//! write commands are that caller — see the "Write-path staging API"
//! section below, and `workspace::write::write_presentation_file`, the one
//! door every one of those commands writes through.
//!
//! Storage lives INSIDE the presentation's own `.slidra` deck file
//! ([E6.T6]), in three side tables (`deck::ensure_history_schema`) that sit
//! alongside the deck's `content` table — never in a separate
//! `<SLIDRA_HOME>/history/` tree. Copying the deck file therefore carries
//! its undo history with it, and `~/.slidra/history/` is never created. It
//! is a snapshot store, not an inverse-operation log: an entry is the
//! complete prior content of one changed file, addressed only by its
//! virtual path (ADR-0004) — this module has no idea what a slide or an
//! element is.
//!
//! Public API:
//! - `undo(id) -> SlidraResult<UndoResult>` — undoes the most recent
//!   group, moving it onto the redo stack.
//! - `redo(id) -> SlidraResult<UndoResult>` — redoes the most recently
//!   undone group, moving it back onto the undo stack (subject to the same
//!   `UNDO_STACK_CAP` as any other push onto that stack).
//!
//! Both take only `id` (not `work_dir`/`history_dir` explicitly) and resolve
//! `SLIDRA_HOME` plus the work directory themselves via `crate::workspace`
//! — mirroring `undoLastGroup`/`redoLastGroup`'s actual TS signatures
//! (`(id: string)`, internally calling `resolveSlidraHome`/
//! `resolveWorkDir`) rather than pushing that resolution onto every call
//! site. A CLI command handler for `slidra undo`/`redo` needs only the
//! presentation id argv already gives it.

use crate::deck;
use crate::errors::{SlidraError, SlidraResult};
use crate::id;
use crate::workspace::{self, virtual_fs};
use rusqlite::{Connection, params};
use std::path::Path;

/// Undo stack depth cap. Each entry is a full copy of a changed file and
/// there is no "close" command to trigger cleanup of an open presentation's
/// history, so an unbounded stack is a disk leak with no exit. Exceeding
/// this drops the oldest group and deletes the snapshot files it referenced.
///
/// Note this cap is enforced only where the TS original enforces it: pushes
/// onto the `undo` array (via `push_group_to_undo_stack`, used here only by
/// `redo`). `undo`'s own push onto the `redo` array
/// (`stack.redo.push(inverse_group)`) is NOT capped in the TS source either
/// — it does not need its own cap because `redo`'s length can never exceed
/// the number of consecutive `undo` calls since the last edit, which is
/// itself bounded by `undo`'s own capped length. Do not "fix" this into a
/// symmetric cap on both arrays; that would diverge from the ported
/// behavior.
///
/// [E6.T6] raised this from 50 to 500 groups now that history lives inside
/// the deck file itself — see `UNDO_SNAPSHOT_BYTES_CAP` below for the
/// second, byte-budget cap that now also applies to the same push.
const UNDO_STACK_CAP: usize = 500;

/// Total `history_snapshot.data` bytes budget (sum across the WHOLE table —
/// undo, redo, and any open group all draw from the same pool), enforced
/// alongside `UNDO_STACK_CAP` by every push onto the undo stack. Exceeding
/// it evicts the oldest undo group(s) the same way the count cap does,
/// except it always leaves at least one undo group behind even if that
/// group alone is over budget (a single oversized snapshot is legal, never
/// an error — see `push_group_to_undo_stack`). Since `undo`'s own push onto
/// `redo` is uncapped (this cap's doc paragraph above), the actual worst
/// case total history footprint is bounded by roughly 2x this value, not
/// this value itself.
const UNDO_SNAPSHOT_BYTES_CAP: i64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistoryEntry {
    /// e.g. "slides/001.svg"
    virtual_path: String,
    /// `history_snapshot.snapshot_id`, holding the file's content from
    /// *before* this entry's edit — or `None` when the path did not exist
    /// before the edit (the entry represents the path's *creation*). A
    /// `None` entry undoes by deleting the file instead of restoring
    /// snapshot content.
    snapshot_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HistoryGroup {
    group_id: String,
    entries: Vec<HistoryEntry>,
}

/// `open_group`'s row is `stack = 2` in `history_group` — at most one such
/// row ever exists at a time (`write_stack` rewrites the whole table on
/// every call). `undo`/`redo` never touch or validate its *content*, only
/// round-trip it (see `read_stack`'s doc).
#[derive(Debug, Clone)]
pub(crate) struct StackFile {
    undo: Vec<HistoryGroup>,
    redo: Vec<HistoryGroup>,
    open_group: Option<HistoryGroup>,
}

#[derive(Debug)]
pub struct UndoResult {
    pub restored_paths: Vec<String>,
}

fn corrupted() -> SlidraError {
    SlidraError::invalid("undo history is corrupted")
}

fn sql_err(_: rusqlite::Error) -> SlidraError {
    corrupted()
}

/// Opens `deck_path` and ensures the three history side tables exist —
/// every read/write primitive below goes through this, mirroring
/// `virtual_fs::open`'s "open, then act" shape (`deck.rs` module doc: no
/// cross-call shared connection or transaction, except within
/// `write_stack`'s own single call).
fn open(deck_path: &Path) -> SlidraResult<Connection> {
    let conn = deck::open_connection(deck_path)
        .map_err(|_| SlidraError::invalid("failed to open undo history"))?;
    deck::ensure_history_schema(&conn)?;
    Ok(conn)
}

fn read_entries(conn: &Connection, group_rowid: i64) -> SlidraResult<Vec<HistoryEntry>> {
    let mut stmt = conn
        .prepare(
            "SELECT virtual_path, snapshot_id FROM history_entry \
             WHERE group_rowid = ?1 ORDER BY position",
        )
        .map_err(sql_err)?;
    let rows = stmt
        .query_map(params![group_rowid], |row| {
            Ok(HistoryEntry {
                virtual_path: row.get(0)?,
                snapshot_id: row.get(1)?,
            })
        })
        .map_err(sql_err)?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(sql_err)?);
    }
    Ok(entries)
}

/// Reads the whole stack out of `deck_path`'s side tables. A deck with no
/// history tables yet (never edited, or written before [E6.T6]) is an empty
/// stack; anything else — a malformed `stack` value outside 0/1/2, more
/// than one `stack = 2` (open group) row, or an entry whose `group_rowid`
/// matches no group row — is a loud `SlidraError`, never a silent fallback
/// to empty. All of those failure modes deliberately collapse to the same
/// message ("undo history is corrupted"), matching the pre-[E6.T6] JSON
/// version's "corrupt JSON" / "wrong shape" cases.
///
/// The open group (a previous turn left an edit group open without
/// closing it) is read and round-tripped by `write_stack`, but never
/// inspected or validated beyond "at most one, well-formed" by `undo`/
/// `redo` — they operate purely on the `undo`/`redo` arrays.
fn read_stack(deck_path: &Path) -> SlidraResult<StackFile> {
    let conn = open(deck_path)?;

    let orphan_entries: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM history_entry \
             WHERE group_rowid NOT IN (SELECT id FROM history_group)",
            [],
            |row| row.get(0),
        )
        .map_err(sql_err)?;
    if orphan_entries > 0 {
        return Err(corrupted());
    }

    let mut stmt = conn
        .prepare("SELECT id, group_id, stack FROM history_group ORDER BY stack, position")
        .map_err(sql_err)?;
    let group_rows: Vec<(i64, String, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(sql_err)?
        .collect::<Result<_, _>>()
        .map_err(sql_err)?;

    let mut undo = Vec::new();
    let mut redo = Vec::new();
    let mut open_group = None;
    for (group_rowid, group_id, stack_kind) in group_rows {
        let group = HistoryGroup {
            group_id,
            entries: read_entries(&conn, group_rowid)?,
        };
        match stack_kind {
            0 => undo.push(group),
            1 => redo.push(group),
            2 if open_group.is_none() => open_group = Some(group),
            _ => return Err(corrupted()),
        }
    }

    Ok(StackFile {
        undo,
        redo,
        open_group,
    })
}

/// Rewrites the whole stack in one transaction: every `history_group`/
/// `history_entry` row is deleted and every group in `stack` re-inserted —
/// simpler and no less atomic than diffing against what is already there,
/// and it keeps `position` always exactly matching each array's current
/// index. Never touches `history_snapshot` — deleting a now-unreferenced
/// snapshot row is always a separate, later step (see `delete_snapshot`'s
/// call sites), never folded into this rewrite.
fn write_stack(deck_path: &Path, stack: &StackFile) -> SlidraResult<()> {
    let mut conn = open(deck_path)?;
    let tx = conn
        .transaction()
        .map_err(|_| SlidraError::invalid("failed to write undo history"))?;

    tx.execute("DELETE FROM history_entry", [])
        .map_err(|_| SlidraError::invalid("failed to write undo history"))?;
    tx.execute("DELETE FROM history_group", [])
        .map_err(|_| SlidraError::invalid("failed to write undo history"))?;

    for (stack_kind, groups) in [(0i64, &stack.undo), (1i64, &stack.redo)] {
        for (position, group) in groups.iter().enumerate() {
            write_group(&tx, group, stack_kind, position as i64)?;
        }
    }
    if let Some(open_group) = &stack.open_group {
        write_group(&tx, open_group, 2, 0)?;
    }

    tx.commit()
        .map_err(|_| SlidraError::invalid("failed to write undo history"))
}

fn write_group(
    tx: &rusqlite::Transaction,
    group: &HistoryGroup,
    stack_kind: i64,
    position: i64,
) -> SlidraResult<()> {
    tx.execute(
        "INSERT INTO history_group (group_id, stack, position) VALUES (?1, ?2, ?3)",
        params![group.group_id, stack_kind, position],
    )
    .map_err(|_| SlidraError::invalid("failed to write undo history"))?;
    let group_rowid = tx.last_insert_rowid();
    for (entry_position, entry) in group.entries.iter().enumerate() {
        tx.execute(
            "INSERT INTO history_entry (group_rowid, position, virtual_path, snapshot_id) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                group_rowid,
                entry_position as i64,
                entry.virtual_path,
                entry.snapshot_id
            ],
        )
        .map_err(|_| SlidraError::invalid("failed to write undo history"))?;
    }
    Ok(())
}

/// Writes one snapshot row, as raw bytes — this module has no idea whether
/// `content` is UTF-8 text or a binary asset's original bytes, so neither
/// ever goes through a decode/re-encode round trip that could alter it.
fn write_snapshot(deck_path: &Path, snapshot_id: &str, content: &[u8]) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    conn.execute(
        "INSERT INTO history_snapshot (snapshot_id, data) VALUES (?1, ?2)
         ON CONFLICT(snapshot_id) DO UPDATE SET data = excluded.data",
        params![snapshot_id, content],
    )
    .map_err(|_| SlidraError::invalid("failed to write undo snapshot"))?;
    Ok(())
}

/// A stack row still pointing at a snapshot id with no matching
/// `history_snapshot` row is always a hard error here — never skip the
/// entry and pretend the group is smaller than it is.
fn read_snapshot(deck_path: &Path, snapshot_id: &str) -> SlidraResult<Vec<u8>> {
    let conn = open(deck_path)?;
    conn.query_row(
        "SELECT data FROM history_snapshot WHERE snapshot_id = ?1",
        params![snapshot_id],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .map_err(|_| corrupted())
}

/// Deletes one snapshot row. A row that is already gone is not an error
/// (`DELETE` matching zero rows is not a SQL failure); any other failure
/// (e.g. the underlying I/O erroring) is a real problem and must not be
/// swallowed.
fn delete_snapshot(deck_path: &Path, snapshot_id: &str) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    conn.execute(
        "DELETE FROM history_snapshot WHERE snapshot_id = ?1",
        params![snapshot_id],
    )
    .map_err(|_| SlidraError::invalid("failed to delete undo snapshot"))?;
    Ok(())
}

fn total_snapshot_bytes(conn: &Connection) -> SlidraResult<i64> {
    conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM history_snapshot",
        [],
        |row| row.get(0),
    )
    .map_err(sql_err)
}

fn group_snapshot_bytes(conn: &Connection, group: &HistoryGroup) -> SlidraResult<i64> {
    let mut total = 0i64;
    for entry in &group.entries {
        if let Some(snapshot_id) = &entry.snapshot_id {
            total += conn
                .query_row(
                    "SELECT LENGTH(data) FROM history_snapshot WHERE snapshot_id = ?1",
                    params![snapshot_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(sql_err)?;
        }
    }
    Ok(total)
}

fn evict_oldest_undo_group(stack: &mut StackFile, evicted_snapshot_ids: &mut Vec<String>) {
    let evicted = stack.undo.remove(0);
    for entry in evicted.entries {
        if let Some(snapshot_id) = entry.snapshot_id {
            evicted_snapshot_ids.push(snapshot_id);
        }
    }
}

/// Pushes `group` onto `stack.undo` (always the `undo` array at every call
/// site in this ported slice — see `UNDO_STACK_CAP`'s doc) and enforces
/// both caps by evicting the oldest group(s), first by count
/// (`UNDO_STACK_CAP`) then by total snapshot bytes
/// (`UNDO_SNAPSHOT_BYTES_CAP`, queried from `deck_path`'s
/// `history_snapshot` table — the byte budget is shared across undo, redo,
/// and any open group, not tracked separately per array). The byte-cap
/// eviction never drops the last remaining undo group, even when that
/// group alone is over budget: a single oversized snapshot is legal, not
/// an error. Returns every evicted group's snapshot ids rather than
/// deleting them here — the caller must not delete a snapshot row until
/// the `write_stack` that drops the last reference to it has actually
/// succeeded.
fn push_group_to_undo_stack(
    deck_path: &Path,
    stack: &mut StackFile,
    group: HistoryGroup,
) -> SlidraResult<Vec<String>> {
    stack.undo.push(group);
    let mut evicted_snapshot_ids = Vec::new();

    while stack.undo.len() > UNDO_STACK_CAP {
        evict_oldest_undo_group(stack, &mut evicted_snapshot_ids);
    }

    if stack.undo.len() > 1 {
        let conn = open(deck_path)?;
        let mut total_bytes = total_snapshot_bytes(&conn)?;
        while stack.undo.len() > 1 && total_bytes > UNDO_SNAPSHOT_BYTES_CAP {
            let freed = group_snapshot_bytes(&conn, &stack.undo[0])?;
            evict_oldest_undo_group(stack, &mut evicted_snapshot_ids);
            total_bytes -= freed;
        }
    }

    Ok(evicted_snapshot_ids)
}

/// `read_virtual_file_bytes`, except a genuinely-absent path is `None`
/// rather than an error — the existence check `apply_group` needs to tell
/// "overwrite" apart from "create"/"delete" while capturing the inverse of
/// either direction.
fn read_virtual_file_bytes_or_none(
    deck_path: &Path,
    virtual_path: &str,
) -> SlidraResult<Option<Vec<u8>>> {
    match virtual_fs::read_virtual_file_bytes(deck_path, virtual_path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(SlidraError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Deletes `virtual_path` if it currently exists; a no-op if it does not
/// (undoing a creation twice must not be an error).
fn delete_real_file_if_present(deck_path: &Path, virtual_path: &str) -> SlidraResult<()> {
    virtual_fs::delete_file_if_present(deck_path, virtual_path)
}

struct ApplyGroupResult {
    inverse_group: HistoryGroup,
    restored_paths: Vec<String>,
    consumed_snapshot_ids: Vec<String>,
}

/// Applies one group's snapshots to disk and returns the group that would
/// undo this application (used by both `undo` and `redo` — they are the
/// same operation run against opposite stacks).
///
/// Every entry's *current* state is captured first, before any entry is
/// applied — either its current bytes, or `None` when the path currently
/// does not exist. This matters when the same `virtual_path` appears more
/// than once in a group: capturing before any write means every entry for
/// that path captures the same, correct "current" value, regardless of
/// processing order.
///
/// Entries are then applied last-to-first. A group's entries were recorded
/// in the order their edits happened, each holding the content from
/// *before* that edit — applying in reverse peels the edits off like a
/// stack, so a path touched twice ends up at the state before its FIRST
/// edit, not its second. An entry with `snapshot_id: None` means the path
/// did not exist before this group ran, so "applying" it means deleting the
/// path instead of writing content back.
///
/// The snapshot rows this group *consumes* are returned rather than
/// deleted here — the caller's `write_stack` has not run yet, so the deck
/// on disk still lists this group as referencing them.
fn apply_group(deck_path: &Path, group: &HistoryGroup) -> SlidraResult<ApplyGroupResult> {
    let mut inverse_entries = Vec::with_capacity(group.entries.len());
    for entry in &group.entries {
        let current = read_virtual_file_bytes_or_none(deck_path, &entry.virtual_path)?;
        match current {
            None => inverse_entries.push(HistoryEntry {
                virtual_path: entry.virtual_path.clone(),
                snapshot_id: None,
            }),
            Some(bytes) => {
                let inverse_snapshot_id = id::generate_opaque_id();
                write_snapshot(deck_path, &inverse_snapshot_id, &bytes)?;
                inverse_entries.push(HistoryEntry {
                    virtual_path: entry.virtual_path.clone(),
                    snapshot_id: Some(inverse_snapshot_id),
                });
            }
        }
    }

    let mut consumed_snapshot_ids = Vec::new();
    for entry in group.entries.iter().rev() {
        match &entry.snapshot_id {
            None => delete_real_file_if_present(deck_path, &entry.virtual_path)?,
            Some(snapshot_id) => {
                let content = read_snapshot(deck_path, snapshot_id)?;
                virtual_fs::force_write_file(deck_path, &entry.virtual_path, &content)?;
                consumed_snapshot_ids.push(snapshot_id.clone());
            }
        }
    }

    // `[...new Set(...)]` in TS: dedup while preserving first-occurrence order.
    let mut seen = std::collections::HashSet::new();
    let mut restored_paths = Vec::new();
    for entry in &group.entries {
        if seen.insert(entry.virtual_path.clone()) {
            restored_paths.push(entry.virtual_path.clone());
        }
    }

    Ok(ApplyGroupResult {
        inverse_group: HistoryGroup {
            group_id: group.group_id.clone(),
            entries: inverse_entries,
        },
        restored_paths,
        consumed_snapshot_ids,
    })
}

/// Undoes the most recent group, moving it onto the redo stack.
pub fn undo(id: &str) -> SlidraResult<UndoResult> {
    let deck_path = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&deck_path)?;
    let group = stack
        .undo
        .pop()
        .ok_or_else(|| SlidraError::invalid("no operation to undo"))?;

    let ApplyGroupResult {
        inverse_group,
        restored_paths,
        consumed_snapshot_ids,
    } = apply_group(&deck_path, &group)?;
    // No cap on this push — see UNDO_STACK_CAP's doc comment.
    stack.redo.push(inverse_group);
    write_stack(&deck_path, &stack)?;

    // Only now is the new stack durable, so only now is it safe to delete
    // the snapshot rows this undo consumed.
    for snapshot_id in &consumed_snapshot_ids {
        delete_snapshot(&deck_path, snapshot_id)?;
    }
    Ok(UndoResult { restored_paths })
}

/// Redoes the most recently undone group, moving it back onto the undo
/// stack (subject to `UNDO_STACK_CAP`/`UNDO_SNAPSHOT_BYTES_CAP`). The
/// content redone is whatever was on disk at the moment of the
/// corresponding `undo` call, not a second independently-tracked "future"
/// — so a change made outside undo/redo between the `undo` and this `redo`
/// is what comes back.
pub fn redo(id: &str) -> SlidraResult<UndoResult> {
    let deck_path = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&deck_path)?;
    let group = stack
        .redo
        .pop()
        .ok_or_else(|| SlidraError::invalid("no operation to redo"))?;

    let ApplyGroupResult {
        inverse_group,
        restored_paths,
        consumed_snapshot_ids,
    } = apply_group(&deck_path, &group)?;
    let evicted_snapshot_ids = push_group_to_undo_stack(&deck_path, &mut stack, inverse_group)?;
    write_stack(&deck_path, &stack)?;

    // Only now is the new stack durable, so only now is it safe to delete
    // the snapshot rows this redo consumed, plus any cap-evicted group's.
    for snapshot_id in consumed_snapshot_ids
        .iter()
        .chain(evicted_snapshot_ids.iter())
    {
        delete_snapshot(&deck_path, snapshot_id)?;
    }
    Ok(UndoResult { restored_paths })
}

// --- Write-path staging API (packages/core/src/history.ts's
// stageSnapshotEntries/commitSnapshotEntries/discardSnapshotEntries/
// finalizeCommittedEntries/revertCommittedEntries/beginHistoryGroup/
// endHistoryGroup/recordSnapshot) --------------------------------------
//
// [E4.T5] plan section 0 / 3.2: this half was left unported by the previous
// ticket because it had no caller yet — this ticket's 27 write commands are
// that caller. Everything below is a straight port; the storage primitives
// it's built on (`read_stack`/`write_stack`/`write_snapshot`/`read_snapshot`/
// `delete_snapshot`/`push_group_to_undo_stack`) already exist above, shared
// with `undo`/`redo`.

/// The result of `commit_snapshot_entries`, mirroring TS's `CommitResult`.
pub(crate) struct CommitResult {
    /// A deep copy of the stack exactly as it stood before this commit —
    /// before the redo clear, before any cap eviction, before `entries` was
    /// appended. Handed back so a caller whose next step (making the new
    /// content visible) then fails can restore history to precisely this
    /// state via `revert_committed_entries`, instead of reconstructing it
    /// field by field. `StackFile` already derives `Clone`, so this is a
    /// real deep copy (no shared `Vec`/`String` backing with the live
    /// stack), matching TS's `JSON.parse(JSON.stringify(stack))`.
    pub(crate) previous_stack: StackFile,
    /// Snapshot ids this commit orphaned (the redo stack it cleared, plus
    /// any cap-evicted undo group) — not deleted yet. Deleting them here
    /// would make the rollback in `revert_committed_entries` impossible
    /// once the caller's write fails, since `previous_stack` still
    /// references them. The caller must call `finalize_committed_entries`
    /// with this list once it knows the commit will not be reverted.
    pub(crate) pending_deletion_snapshot_ids: Vec<String>,
}

/// Writes a snapshot file for each listed path's *current* content, taken
/// before the caller overwrites it — but does not touch the undo/redo
/// stacks yet. Split from `commit_snapshot_entries` so a caller
/// (`workspace::write::write_presentation_file`) can snapshot first, attempt
/// its actual content write, and only then decide whether to commit (write
/// succeeded) or discard (write failed) — so a failed write never occupies
/// an undo slot.
pub(crate) fn stage_snapshot_entries(
    id: &str,
    virtual_paths: &[&str],
) -> SlidraResult<Vec<HistoryEntry>> {
    let deck_path = workspace::resolve_work_dir(id)?;
    let mut entries = Vec::with_capacity(virtual_paths.len());
    for &virtual_path in virtual_paths {
        let content = virtual_fs::read_virtual_file_bytes(&deck_path, virtual_path)?;
        let snapshot_id = id::generate_opaque_id();
        write_snapshot(&deck_path, &snapshot_id, &content)?;
        entries.push(HistoryEntry {
            virtual_path: virtual_path.to_string(),
            snapshot_id: Some(snapshot_id),
        });
    }
    Ok(entries)
}

/// Records that `virtual_path` is about to be created — it does not exist
/// yet — as the creation counterpart to `stage_snapshot_entries` (asset
/// import / `create_presentation_file`, carried over from before this
/// ticket — none of this ticket's own 29 commands create a new file, they
/// all edit an existing slide/template). No I/O and no snapshot file: there
/// is no "before" content to keep, only the fact that the path was absent.
pub(crate) fn stage_new_file_entry(virtual_path: &str) -> HistoryEntry {
    HistoryEntry {
        virtual_path: virtual_path.to_string(),
        snapshot_id: None,
    }
}

/// Commits previously staged entries onto the undo timeline: with an open
/// group (`begin_history_group`), the entries are appended to it; otherwise
/// they become their own single-command undo group immediately. Every call
/// clears the redo stack — undo is a linear timeline, and a new edit after
/// an undo invalidates whatever redo would have replayed.
///
/// Does NOT delete the cleared redo entries' (or any cap-evicted group's)
/// snapshot files itself — see `CommitResult`'s doc. A caller with no
/// failure case of its own between this call and visible effect should
/// immediately follow up with `finalize_committed_entries`; a caller that
/// commits *before* a write that can still fail (`write_presentation_file`,
/// NOOP-337) instead holds `previous_stack` until it knows whether to
/// finalize or revert.
pub(crate) fn commit_snapshot_entries(
    id: &str,
    entries: Vec<HistoryEntry>,
) -> SlidraResult<CommitResult> {
    let deck_path = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&deck_path)?;
    let previous_stack = stack.clone();

    let mut pending_deletion_snapshot_ids = Vec::new();
    for group in &stack.redo {
        for entry in &group.entries {
            if let Some(snapshot_id) = &entry.snapshot_id {
                pending_deletion_snapshot_ids.push(snapshot_id.clone());
            }
        }
    }
    stack.redo.clear();

    if let Some(open_group) = stack.open_group.as_mut() {
        open_group.entries.extend(entries);
    } else {
        let group = HistoryGroup {
            group_id: id::generate_opaque_id(),
            entries,
        };
        pending_deletion_snapshot_ids
            .extend(push_group_to_undo_stack(&deck_path, &mut stack, group)?);
    }

    write_stack(&deck_path, &stack)?;

    Ok(CommitResult {
        previous_stack,
        pending_deletion_snapshot_ids,
    })
}

/// Deletes the snapshot rows a `commit_snapshot_entries` call orphaned,
/// once the caller knows that commit will never be reverted.
pub(crate) fn finalize_committed_entries(id: &str, snapshot_ids: &[String]) -> SlidraResult<()> {
    let deck_path = workspace::resolve_work_dir(id)?;
    for snapshot_id in snapshot_ids {
        delete_snapshot(&deck_path, snapshot_id)?;
    }
    Ok(())
}

/// Deletes snapshot rows staged by `stage_snapshot_entries` whose write was
/// never committed — the caller's actual content write failed, so these
/// would otherwise sit unreferenced by any stack.
pub(crate) fn discard_snapshot_entries(id: &str, entries: &[HistoryEntry]) -> SlidraResult<()> {
    let deck_path = workspace::resolve_work_dir(id)?;
    for entry in entries {
        if let Some(snapshot_id) = &entry.snapshot_id {
            delete_snapshot(&deck_path, snapshot_id)?;
        }
    }
    Ok(())
}

/// Reverses one `commit_snapshot_entries(id, entries)` call whose caller's
/// next step — making the new content visible — then failed (NOOP-337:
/// `write_presentation_file` commits the undo group *before* renaming its
/// temp file onto the real path, precisely so undo is never unavailable for
/// content a reader can already see; a failed rename must therefore undo
/// that commit too, or the commit would occupy an undo slot for a write
/// that never actually took visible effect).
///
/// Writes `previous_stack` back verbatim — restoring the redo stack it
/// cleared and any group it cap-evicted, not just popping the group it
/// pushed. Because `commit_snapshot_entries` never deleted those redo/
/// evicted snapshot files (only staged them for deletion), they are still
/// on disk for `previous_stack` to reference. `entries`' own staged
/// snapshot files (the failed write's own "before" content) are discarded,
/// since the content they exist for never got written. Must be called with
/// the same `entries`/`previous_stack` pair immediately after
/// `commit_snapshot_entries`, before anything else commits against this id.
pub(crate) fn revert_committed_entries(
    id: &str,
    entries: &[HistoryEntry],
    previous_stack: &StackFile,
) -> SlidraResult<()> {
    let deck_path = workspace::resolve_work_dir(id)?;
    write_stack(&deck_path, previous_stack)?;
    discard_snapshot_entries(id, entries)
}

/// Registers a snapshot of each listed file's current content and commits
/// it onto the undo timeline immediately — `stage_snapshot_entries`
/// followed by `commit_snapshot_entries`. The simple, single-call entry
/// point for a caller with no failure-before-commit case of its own to
/// guard against. Not currently called by any of this ticket's 29 commands
/// (each of them goes through `write_presentation_file`'s stage/write/
/// commit-or-revert bracket instead, per NOOP-337) — ported anyway because
/// it is one of the eight functions this module's write half is committed
/// to carrying (module doc, plan section 3.2), for a future caller that
/// (like a plain asset write) has no write-can-still-fail step after the
/// commit to guard against.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn record_snapshot(id: &str, virtual_paths: &[&str]) -> SlidraResult<()> {
    let entries = stage_snapshot_entries(id, virtual_paths)?;
    let CommitResult {
        pending_deletion_snapshot_ids,
        ..
    } = commit_snapshot_entries(id, entries)?;
    finalize_committed_entries(id, &pending_deletion_snapshot_ids)
}

/// Opens a group that spans multiple commands (an agent's turn) so they
/// undo together as one step. Returns `true` when this call is the one that
/// opened the group — the caller owns it and MUST call `end_history_group`
/// no matter what happens next. Returns `false` when a group was already
/// open — the caller has joined it and MUST NOT close it; its snapshots are
/// appended to the owner's group by `commit_snapshot_entries`, and the
/// owner closes it. Called by each of `slide::ops`'s (`slide/ops.rs`, [F3])
/// six multi-write operations to bracket their own several
/// `write_presentation_file` calls into one undo step; also correctly
/// commits into a TS-server-opened group via `commit_snapshot_entries`'s
/// `open_group` branch, since `packages/server`'s own turn grouping and
/// this module's are the same deck's `open_group` row.
pub(crate) fn begin_history_group(id: &str) -> SlidraResult<bool> {
    let deck_path = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&deck_path)?;
    if stack.open_group.is_some() {
        return Ok(false);
    }
    stack.open_group = Some(HistoryGroup {
        group_id: id::generate_opaque_id(),
        entries: Vec::new(),
    });
    write_stack(&deck_path, &stack)?;
    Ok(true)
}

/// Closes the group opened by `begin_history_group` and pushes it onto the
/// undo stack as one step. An empty group (no command in it ever wrote
/// anything) is discarded rather than pushed, so an undo never lands on a
/// step that visibly does nothing. Called by each of `slide/ops.rs`'s six
/// multi-write operations, always paired with the `begin_history_group`
/// call that opened the group it closes — see that function's doc comment.
pub(crate) fn end_history_group(id: &str) -> SlidraResult<()> {
    let deck_path = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&deck_path)?;
    let group = stack
        .open_group
        .take()
        .ok_or_else(|| SlidraError::invalid("no open undo group"))?;
    let evicted_snapshot_ids = if group.entries.is_empty() {
        Vec::new()
    } else {
        push_group_to_undo_stack(&deck_path, &mut stack, group)?
    };
    write_stack(&deck_path, &stack)?;
    for snapshot_id in &evicted_snapshot_ids {
        delete_snapshot(&deck_path, snapshot_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-history-{label}-{}",
            id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Builds a `HistoryGroup` from a plain literal shape — the test-seeding
    /// equivalent of the old hand-written `stack.json` string literals, now
    /// building rows in the deck's side tables via `write_stack` instead.
    fn group(group_id: &str, entries: &[(&str, Option<&str>)]) -> HistoryGroup {
        HistoryGroup {
            group_id: group_id.to_string(),
            entries: entries
                .iter()
                .map(|(virtual_path, snapshot_id)| HistoryEntry {
                    virtual_path: virtual_path.to_string(),
                    snapshot_id: snapshot_id.map(|s| s.to_string()),
                })
                .collect(),
        }
    }

    /// Seeds `deck`'s history side tables directly via `write_stack` — the
    /// test-seeding replacement for hand-writing a `stack.json` literal.
    fn seed_stack(deck: &Path, undo: Vec<HistoryGroup>, redo: Vec<HistoryGroup>) {
        write_stack(
            deck,
            &StackFile {
                undo,
                redo,
                open_group: None,
            },
        )
        .unwrap();
    }

    struct Fixture {
        home: PathBuf,
        deck: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        /// Builds an empty deck (just the `container::REQUIRED_DIRS`) and
        /// registers it as `test_id` under a fresh `SLIDRA_HOME`. Content
        /// for a specific test is written afterwards via `Fixture::write`.
        fn new(label: &str, test_id: &str) -> Self {
            let guard = workspace::registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let deck = crate::deck::build_test_deck(label, &[]);
            workspace::registry::register_for_test(&home, test_id, &deck);
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            Fixture {
                home,
                deck,
                _guard: guard,
            }
        }

        /// Writes `virtual_path`'s current on-disk content directly
        /// (bypassing undo staging) — the deck-backed equivalent of the
        /// old `std::fs::write(fixture.work.join(virtual_path), ...)`.
        fn write(&self, virtual_path: &str, content: &[u8]) {
            virtual_fs::force_write_file(&self.deck, virtual_path, content).unwrap();
        }

        fn read(&self, virtual_path: &str) -> Vec<u8> {
            virtual_fs::read_virtual_file_bytes(&self.deck, virtual_path).unwrap()
        }

        fn exists(&self, virtual_path: &str) -> bool {
            virtual_fs::assert_file_exists(&self.deck, virtual_path).is_ok()
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
    fn undo_with_no_history_file_reports_nothing_to_undo() {
        let fixture = Fixture::new("no-file", "pid-no-file");
        let err = undo("pid-no-file").unwrap_err();
        // A deck with no history tables yet must be treated as an empty
        // stack (not "corrupted"), so the observed error is the
        // empty-undo-stack one.
        assert_eq!(err.message(), "no operation to undo");
        drop(fixture);
    }

    #[test]
    fn undo_then_redo_round_trips_exact_byte_content() {
        let fixture = Fixture::new("roundtrip", "pid-roundtrip");
        fixture.write("slides/001.svg", b"<svg>ORIGINAL</svg>");

        write_snapshot(&fixture.deck, "snap-before", b"<svg>BEFORE</svg>").unwrap();
        seed_stack(
            &fixture.deck,
            vec![group("g1", &[("slides/001.svg", Some("snap-before"))])],
            vec![],
        );

        let undo_result = undo("pid-roundtrip").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(fixture.read("slides/001.svg"), b"<svg>BEFORE</svg>");
        // The consumed snapshot is deleted only after the write_stack call
        // that drops the last reference to it succeeds.
        assert!(matches!(
            read_snapshot(&fixture.deck, "snap-before"),
            Err(_)
        ));

        let redo_result = redo("pid-roundtrip").unwrap();
        assert_eq!(
            redo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(fixture.read("slides/001.svg"), b"<svg>ORIGINAL</svg>");

        drop(fixture);
    }

    #[test]
    fn undo_with_null_snapshot_id_deletes_the_file() {
        let fixture = Fixture::new("null-snapshot", "pid-null");
        fixture.write("assets/new.png", b"fresh import bytes");

        seed_stack(
            &fixture.deck,
            vec![group("g1", &[("assets/new.png", None)])],
            vec![],
        );

        let result = undo("pid-null").unwrap();
        assert_eq!(result.restored_paths, vec!["assets/new.png".to_string()]);
        assert!(!fixture.exists("assets/new.png"));

        drop(fixture);
    }

    /// A path touched twice in one group must, after undo, end up at the
    /// state before its FIRST edit — the two-phase capture-then-reverse-
    /// apply order this test exists to pin down.
    #[test]
    fn group_with_same_virtual_path_twice_restores_pre_first_edit_state() {
        let fixture = Fixture::new("same-path-twice", "pid-twice");
        // Current on-disk content: the state AFTER both edits.
        fixture.write("slides/001.svg", b"V3-after-both-edits");

        write_snapshot(&fixture.deck, "snap-v1", b"V1-before-first-edit").unwrap();
        write_snapshot(&fixture.deck, "snap-v2", b"V2-before-second-edit").unwrap();
        seed_stack(
            &fixture.deck,
            vec![group(
                "g1",
                &[
                    ("slides/001.svg", Some("snap-v1")),
                    ("slides/001.svg", Some("snap-v2")),
                ],
            )],
            vec![],
        );

        let result = undo("pid-twice").unwrap();
        // Deduped: one restored path even though the group has two entries
        // for it.
        assert_eq!(result.restored_paths, vec!["slides/001.svg".to_string()]);
        assert_eq!(fixture.read("slides/001.svg"), b"V1-before-first-edit");

        drop(fixture);
    }

    /// Reads back `history_group.group_id` for `stack = 0` (undo), ordered
    /// by `position` — the direct row-level equivalent of the old
    /// `stack.json["undo"].map(g => g.groupId)`.
    fn undo_group_ids(deck: &Path) -> Vec<String> {
        let conn = Connection::open(deck).unwrap();
        let mut stmt = conn
            .prepare("SELECT group_id FROM history_group WHERE stack = 0 ORDER BY position")
            .unwrap();
        stmt.query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn snapshot_row_exists(deck: &Path, snapshot_id: &str) -> bool {
        let conn = Connection::open(deck).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM history_snapshot WHERE snapshot_id = ?1",
            params![snapshot_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    /// Pushing a 501st group onto the undo stack (here via `redo`, the only
    /// call site in this ported slice that can grow `undo` past one entry
    /// at a time under test control) drops the oldest group and deletes the
    /// snapshot row(s) it referenced.
    #[test]
    fn cap_evicts_oldest_undo_group_and_deletes_its_snapshot() {
        let fixture = Fixture::new("cap", "pid-cap");
        fixture.write("live/001.svg", b"content-before-redo");

        write_snapshot(&fixture.deck, "snap-u0", b"oldest-group-content").unwrap();
        write_snapshot(&fixture.deck, "snap-r1", b"redo-content").unwrap();

        let mut undo_groups = Vec::with_capacity(UNDO_STACK_CAP);
        for i in 0..UNDO_STACK_CAP {
            let entries: Vec<(&str, Option<&str>)> = if i == 0 {
                vec![("dummy/0.txt", Some("snap-u0"))]
            } else {
                vec![("dummy/leaked.txt", None)]
            };
            undo_groups.push(group(&format!("u{i}"), &entries));
        }
        seed_stack(
            &fixture.deck,
            undo_groups,
            vec![group("r1", &[("live/001.svg", Some("snap-r1"))])],
        );

        let result = redo("pid-cap").unwrap();
        assert_eq!(result.restored_paths, vec!["live/001.svg".to_string()]);
        assert_eq!(fixture.read("live/001.svg"), b"redo-content");

        let undo_ids = undo_group_ids(&fixture.deck);
        assert_eq!(undo_ids.len(), UNDO_STACK_CAP);
        // Oldest group (u0) evicted; u1 is now the first entry.
        assert_eq!(undo_ids[0], "u1");
        // The new inverse-of-redo group lands at the end, keeping r1's id.
        assert_eq!(undo_ids[UNDO_STACK_CAP - 1], "r1");

        // Evicted group's snapshot is gone; the redo's own consumed
        // snapshot is gone too.
        assert!(!snapshot_row_exists(&fixture.deck, "snap-u0"));
        assert!(!snapshot_row_exists(&fixture.deck, "snap-r1"));

        drop(fixture);
    }

    /// [E6.T6] D3: once total `history_snapshot` bytes exceed
    /// `UNDO_SNAPSHOT_BYTES_CAP`, the oldest undo group(s) are evicted the
    /// same way the count cap evicts them — even though the count itself
    /// stays well under `UNDO_STACK_CAP`.
    #[test]
    fn byte_cap_evicts_oldest_undo_group_once_snapshot_total_exceeds_it() {
        let fixture = Fixture::new("byte-cap", "pid-byte-cap");
        fixture.write("live/001.svg", b"content-before-edit");

        let big = vec![0u8; (UNDO_SNAPSHOT_BYTES_CAP - 5) as usize];
        write_snapshot(&fixture.deck, "snap-u0-big", &big).unwrap();
        seed_stack(
            &fixture.deck,
            vec![group("u0", &[("dummy/0.bin", Some("snap-u0-big"))])],
            vec![],
        );

        // A second, small edit pushes a new group onto `undo` (via the same
        // stage/commit path `write_presentation_file` uses) — total
        // snapshot bytes now exceeds the cap, so `u0` (the oldest) must be
        // evicted, leaving only the new group behind.
        let entries = stage_snapshot_entries("pid-byte-cap", &["live/001.svg"]).unwrap();
        let commit = commit_snapshot_entries("pid-byte-cap", entries).unwrap();
        finalize_committed_entries("pid-byte-cap", &commit.pending_deletion_snapshot_ids).unwrap();

        let undo_ids = undo_group_ids(&fixture.deck);
        assert_eq!(
            undo_ids.len(),
            1,
            "the oversized older group must be evicted"
        );
        assert!(!snapshot_row_exists(&fixture.deck, "snap-u0-big"));

        drop(fixture);
    }

    /// [E6.T6] D3: the byte cap never evicts the LAST remaining undo group
    /// — a single snapshot larger than the whole cap is legal and kept.
    #[test]
    fn byte_cap_never_evicts_the_last_remaining_undo_group() {
        let fixture = Fixture::new("byte-cap-floor", "pid-byte-cap-floor");
        let huge = vec![0u8; (UNDO_SNAPSHOT_BYTES_CAP + 1_000) as usize];
        fixture.write("assets/huge.bin", &huge);

        let entries = stage_snapshot_entries("pid-byte-cap-floor", &["assets/huge.bin"]).unwrap();
        let commit = commit_snapshot_entries("pid-byte-cap-floor", entries).unwrap();
        finalize_committed_entries("pid-byte-cap-floor", &commit.pending_deletion_snapshot_ids)
            .unwrap();

        assert_eq!(
            undo_group_ids(&fixture.deck).len(),
            1,
            "a single snapshot larger than the byte cap must still occupy its own undo step"
        );

        drop(fixture);
    }

    /// Replaces the pre-[E6.T6] `corrupted_stack_json_is_reported_as_damaged_history`
    /// and `wrong_shaped_stack_json_is_reported_as_damaged_history`: under
    /// the SQLite-backed storage there is no JSON text to corrupt, so both
    /// degrade to the same "a row has a shape `read_stack` refuses to
    /// accept" case — a `history_group.stack` value outside 0/1/2.
    #[test]
    fn malformed_history_rows_are_reported_as_damaged_history() {
        let fixture = Fixture::new("corrupt-shape", "pid-corrupt");
        let conn = Connection::open(&fixture.deck).unwrap();
        deck::ensure_history_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO history_group (group_id, stack, position) VALUES ('g1', 9, 0)",
            [],
        )
        .unwrap();
        let err = undo("pid-corrupt").unwrap_err();
        assert_eq!(err.message(), "undo history is corrupted");
        drop(fixture);
    }

    #[test]
    fn history_row_referencing_a_missing_snapshot_is_damaged_history() {
        let fixture = Fixture::new("missing-snapshot", "pid-missing-snap");
        fixture.write("slides/001.svg", b"current");
        // References a snapshot id whose row was never written.
        seed_stack(
            &fixture.deck,
            vec![group("g1", &[("slides/001.svg", Some("never-written"))])],
            vec![],
        );
        let err = undo("pid-missing-snap").unwrap_err();
        assert_eq!(err.message(), "undo history is corrupted");
        drop(fixture);
    }

    // --- Write-path staging API ---------------------------------------

    #[test]
    fn stage_commit_finalize_round_trips_through_undo() {
        let fixture = Fixture::new("stage-commit", "pid-stage-commit");
        fixture.write("slides/001.svg", b"<svg>BEFORE</svg>");

        // Simulates write_presentation_file's stage -> commit -> write ->
        // finalize sequence (commit BEFORE the content write, per NOOP-337).
        let entries = stage_snapshot_entries("pid-stage-commit", &["slides/001.svg"]).unwrap();
        let CommitResult {
            pending_deletion_snapshot_ids,
            ..
        } = commit_snapshot_entries("pid-stage-commit", entries).unwrap();
        fixture.write("slides/001.svg", b"<svg>AFTER</svg>");
        finalize_committed_entries("pid-stage-commit", &pending_deletion_snapshot_ids).unwrap();

        // Exactly one undo step was occupied, and it restores the pre-write
        // content.
        let result = undo("pid-stage-commit").unwrap();
        assert_eq!(result.restored_paths, vec!["slides/001.svg".to_string()]);
        assert_eq!(fixture.read("slides/001.svg"), b"<svg>BEFORE</svg>");
        assert!(
            undo("pid-stage-commit").is_err(),
            "only one step was committed"
        );

        drop(fixture);
    }

    /// A commit followed by a failed content write must be undone via
    /// `revert_committed_entries` — the failed write must not occupy an
    /// undo slot, and it must not leave the staged "before" snapshot
    /// orphaned on disk either.
    #[test]
    fn revert_after_a_failed_write_leaves_no_undo_step_and_no_orphan_snapshot() {
        let fixture = Fixture::new("revert", "pid-revert");
        fixture.write("slides/001.svg", b"<svg>ORIGINAL</svg>");

        let entries = stage_snapshot_entries("pid-revert", &["slides/001.svg"]).unwrap();
        let staged_snapshot_id = entries[0].snapshot_id.clone().unwrap();
        let commit = commit_snapshot_entries("pid-revert", entries.clone()).unwrap();
        // The content write itself fails (simulated — never happens here);
        // revert instead of finalize.
        revert_committed_entries("pid-revert", &entries, &commit.previous_stack).unwrap();

        assert!(
            undo("pid-revert").is_err(),
            "reverted commit must not occupy an undo slot"
        );
        assert!(
            !fixture
                .home
                .join("history/pid-revert/snapshots")
                .join(&staged_snapshot_id)
                .exists(),
            "the staged snapshot must not be left behind"
        );
        // The slide itself was never touched by this staging dance.
        assert_eq!(fixture.read("slides/001.svg"), b"<svg>ORIGINAL</svg>");

        drop(fixture);
    }

    /// A commit clears the redo stack; a subsequent revert restores it
    /// verbatim (NOOP-333 Fix.7r2) rather than merely undoing the group it
    /// pushed.
    #[test]
    fn revert_restores_a_redo_stack_the_commit_had_cleared() {
        let fixture = Fixture::new("revert-redo", "pid-revert-redo");
        fixture.write("slides/001.svg", b"current");
        write_snapshot(&fixture.deck, "snap-r1", b"redo-content").unwrap();
        seed_stack(
            &fixture.deck,
            vec![],
            vec![group("r1", &[("slides/001.svg", Some("snap-r1"))])],
        );

        let entries = stage_snapshot_entries("pid-revert-redo", &["slides/001.svg"]).unwrap();
        let commit = commit_snapshot_entries("pid-revert-redo", entries.clone()).unwrap();
        revert_committed_entries("pid-revert-redo", &entries, &commit.previous_stack).unwrap();

        // The redo entry the commit cleared is back, and its snapshot file
        // (never actually deleted — only staged for deletion) still resolves.
        let redo_result = redo("pid-revert-redo").unwrap();
        assert_eq!(
            redo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );

        drop(fixture);
    }

    #[test]
    fn record_snapshot_is_stage_commit_finalize_in_one_call() {
        let fixture = Fixture::new("record", "pid-record");
        fixture.write("slides/001.svg", b"<svg>BEFORE</svg>");

        record_snapshot("pid-record", &["slides/001.svg"]).unwrap();
        fixture.write("slides/001.svg", b"<svg>AFTER</svg>");

        let result = undo("pid-record").unwrap();
        assert_eq!(result.restored_paths, vec!["slides/001.svg".to_string()]);
        assert_eq!(fixture.read("slides/001.svg"), b"<svg>BEFORE</svg>");

        drop(fixture);
    }

    #[test]
    fn discard_snapshot_entries_removes_unreferenced_staged_files() {
        let fixture = Fixture::new("discard", "pid-discard");
        fixture.write("slides/001.svg", b"content");

        let entries = stage_snapshot_entries("pid-discard", &["slides/001.svg"]).unwrap();
        let snapshot_id = entries[0].snapshot_id.clone().unwrap();
        assert!(snapshot_row_exists(&fixture.deck, &snapshot_id));

        discard_snapshot_entries("pid-discard", &entries).unwrap();
        assert!(!snapshot_row_exists(&fixture.deck, &snapshot_id));

        drop(fixture);
    }

    #[test]
    fn stage_new_file_entry_has_no_snapshot_id() {
        let entry = stage_new_file_entry("assets/new.png");
        assert_eq!(entry.virtual_path, "assets/new.png");
        assert!(entry.snapshot_id.is_none());
    }

    /// Two commits made while a group is open join the SAME undo group;
    /// `end_history_group` closes it as one step that undoes both edits
    /// together.
    #[test]
    fn commits_inside_an_open_group_join_it_as_one_undo_step() {
        let fixture = Fixture::new("group", "pid-group");
        fixture.write("slides/001.svg", b"A-before");
        fixture.write("slides/002.svg", b"B-before");

        let opened = begin_history_group("pid-group").unwrap();
        assert!(opened, "first caller must open the group");
        assert!(
            !begin_history_group("pid-group").unwrap(),
            "a second caller joins rather than re-opening"
        );

        let entries_a = stage_snapshot_entries("pid-group", &["slides/001.svg"]).unwrap();
        commit_snapshot_entries("pid-group", entries_a).unwrap();
        fixture.write("slides/001.svg", b"A-after");

        let entries_b = stage_snapshot_entries("pid-group", &["slides/002.svg"]).unwrap();
        commit_snapshot_entries("pid-group", entries_b).unwrap();
        fixture.write("slides/002.svg", b"B-after");

        end_history_group("pid-group").unwrap();

        // One undo restores BOTH slides — proof the two commits landed in
        // one group, not two.
        let result = undo("pid-group").unwrap();
        let mut restored = result.restored_paths;
        restored.sort();
        assert_eq!(
            restored,
            vec!["slides/001.svg".to_string(), "slides/002.svg".to_string()]
        );
        assert_eq!(fixture.read("slides/001.svg"), b"A-before");
        assert_eq!(fixture.read("slides/002.svg"), b"B-before");
        assert!(undo("pid-group").is_err(), "only one step was pushed");

        drop(fixture);
    }

    /// A group opened but never committed into is discarded on close, not
    /// pushed as a no-op undo step.
    #[test]
    fn end_history_group_discards_an_empty_group() {
        let fixture = Fixture::new("empty-group", "pid-empty-group");
        assert!(begin_history_group("pid-empty-group").unwrap());
        end_history_group("pid-empty-group").unwrap();
        assert!(
            undo("pid-empty-group").is_err(),
            "an empty group must not occupy an undo step"
        );
        drop(fixture);
    }

    #[test]
    fn end_history_group_without_an_open_group_errors() {
        let fixture = Fixture::new("no-open-group", "pid-no-open-group");
        let err = end_history_group("pid-no-open-group").unwrap_err();
        assert_eq!(err.message(), "no open undo group");
        drop(fixture);
    }
}
