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
//! Storage lives at `<SLIDRA_HOME>/history/<presentation-id>/`, a sibling
//! of `work/<id>/` under the same home — never inside the work directory
//! itself. It is a snapshot store, not an inverse-operation log: an entry is
//! the complete prior content of one changed file, addressed only by its
//! virtual path and presentation id (ADR-0004) — this module has no idea
//! what a slide or an element is.
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

use crate::errors::{SlidraError, SlidraResult};
use crate::id;
use crate::workspace::{self, virtual_fs};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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
const UNDO_STACK_CAP: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryEntry {
    /// e.g. "slides/001.svg"
    virtual_path: String,
    /// Filename under `snapshots/`, holding the file's content from
    /// *before* this entry's edit — or `None` when the path did not exist
    /// before the edit (the entry represents the path's *creation*). A
    /// `None` entry undoes by deleting the file instead of restoring
    /// snapshot content.
    ///
    /// Deliberately a required-but-nullable field, not `#[serde(default)]`:
    /// a `stack.json` entry with this key missing entirely (as opposed to
    /// present-and-`null`) must fail to deserialize, matching the TS
    /// original's `isHistoryEntry` (which treats `undefined` as invalid,
    /// only `null` or a string as valid).
    snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HistoryGroup {
    group_id: String,
    entries: Vec<HistoryEntry>,
}

/// `openGroup`'s presence-but-nullable requirement mirrors `HistoryEntry`'s
/// `snapshot_id` above: `undo`/`redo` never touch or validate its *content*
/// (see `read_stack`'s doc), but the key must still exist in the JSON object
/// for the file to parse as a valid stack at all — the TS original's
/// `isStackFile` rejects a `stack.json` with the `openGroup` key missing
/// entirely, same as it rejects `undo`/`redo` being missing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StackFile {
    undo: Vec<HistoryGroup>,
    redo: Vec<HistoryGroup>,
    open_group: Option<HistoryGroup>,
}

#[derive(Debug)]
pub struct UndoResult {
    pub restored_paths: Vec<String>,
}

fn history_dir_for(home: &Path, id: &str) -> PathBuf {
    home.join("history").join(id)
}

fn stack_path(home: &Path, id: &str) -> PathBuf {
    history_dir_for(home, id).join("stack.json")
}

fn snapshot_path(home: &Path, id: &str, snapshot_id: &str) -> PathBuf {
    history_dir_for(home, id)
        .join("snapshots")
        .join(snapshot_id)
}

/// Reads and parses `stack.json`. A genuinely missing file (never edited
/// yet) is an empty stack; anything else — an I/O error other than "file
/// missing", corrupt JSON, or a malformed shape (`undo` not an array, an
/// entry missing `virtualPath`, ...) — is a loud `SlidraError`, never a
/// silent fallback to empty. All three of those failure modes deliberately
/// collapse to the same message (`復原歷史已損毀`, "undo history is corrupted").
///
/// `openGroup` (a previous turn left an edit group open without closing it)
/// is read and round-tripped by `write_stack`, but never inspected or
/// validated beyond "present and either null or a well-formed group" by
/// `undo`/`redo` — they operate purely on the `undo`/`redo` arrays.
fn read_stack(home: &Path, id: &str) -> SlidraResult<StackFile> {
    let raw = match std::fs::read_to_string(stack_path(home, id)) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StackFile {
                undo: Vec::new(),
                redo: Vec::new(),
                open_group: None,
            });
        }
        Err(_) => return Err(SlidraError::invalid("undo history is corrupted")),
    };
    serde_json::from_str(&raw).map_err(|_| SlidraError::invalid("undo history is corrupted"))
}

/// Atomic write: temp file + rename. Every step (directory creation
/// included) is wrapped so a raw I/O error can never escape this module with
/// a real filesystem path in its message (ADR-0004). On any failure, the
/// temp file is best-effort removed rather than left behind.
fn write_stack(home: &Path, id: &str, stack: &StackFile) -> SlidraResult<()> {
    let dir = history_dir_for(home, id);
    let final_path = stack_path(home, id);
    let temp_path = dir.join(format!(".stack.json.{}.tmp", id::random_hex_suffix()));

    let write_result: std::io::Result<()> = (|| {
        std::fs::create_dir_all(&dir)?;
        // serde_json's pretty printer uses a 2-space indent by default,
        // matching `JSON.stringify(stack, null, 2)`.
        let mut json = serde_json::to_string_pretty(stack)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
        json.push('\n');
        std::fs::write(&temp_path, json)?;
        std::fs::rename(&temp_path, &final_path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
        return Err(SlidraError::invalid("failed to write undo history"));
    }
    Ok(())
}

/// Writes one snapshot file, as raw bytes — this module has no idea whether
/// `content` is UTF-8 text or a binary asset's original bytes, so neither
/// ever goes through a decode/re-encode round trip that could alter it.
fn write_snapshot(home: &Path, id: &str, snapshot_id: &str, content: &[u8]) -> SlidraResult<()> {
    let file_path = snapshot_path(home, id, snapshot_id);
    (|| -> std::io::Result<()> {
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&file_path, content)
    })()
    .map_err(|_| SlidraError::invalid("failed to write undo snapshot"))
}

/// `stack.json` still points at a snapshot file that is no longer there is
/// always a hard error here — never skip the entry and pretend the group is
/// smaller than it is.
fn read_snapshot(home: &Path, id: &str, snapshot_id: &str) -> SlidraResult<Vec<u8>> {
    std::fs::read(snapshot_path(home, id, snapshot_id))
        .map_err(|_| SlidraError::invalid("undo history is corrupted"))
}

/// Deletes one snapshot file. A file that is already gone is not an error
/// (mirrors Node's `rm(..., { force: true })`); any other failure (e.g. a
/// permission error) is a real problem and must not be swallowed.
fn delete_snapshot(home: &Path, id: &str, snapshot_id: &str) -> SlidraResult<()> {
    match std::fs::remove_file(snapshot_path(home, id, snapshot_id)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SlidraError::invalid("failed to delete undo snapshot")),
    }
}

/// Pushes a group onto `list` (always the `undo` array at every call site in
/// this ported slice — see `UNDO_STACK_CAP`'s doc) and enforces the cap by
/// evicting the oldest group once exceeded. Returns the evicted group's
/// snapshot ids rather than deleting them here: the caller must not delete a
/// snapshot file until the `write_stack` that drops the last reference to it
/// has actually succeeded.
fn push_group_to_undo_stack(list: &mut Vec<HistoryGroup>, group: HistoryGroup) -> Vec<String> {
    list.push(group);
    let mut evicted_snapshot_ids = Vec::new();
    while list.len() > UNDO_STACK_CAP {
        let evicted = list.remove(0);
        for entry in evicted.entries {
            if let Some(snapshot_id) = entry.snapshot_id {
                evicted_snapshot_ids.push(snapshot_id);
            }
        }
    }
    evicted_snapshot_ids
}

/// `read_virtual_file_bytes`, except a genuinely-absent path is `None`
/// rather than an error — the existence check `apply_group` needs to tell
/// "overwrite" apart from "create"/"delete" while capturing the inverse of
/// either direction.
fn read_virtual_file_bytes_or_none(
    work_dir: &Path,
    virtual_path: &str,
) -> SlidraResult<Option<Vec<u8>>> {
    match virtual_fs::read_virtual_file_bytes(work_dir, virtual_path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(SlidraError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Derives `virtual_path`'s real filesystem path by direct join, without the
/// structural discovery `virtual_fs::resolve_virtual_file_path` requires
/// (which needs the file to already exist — not true when this group is
/// about to *create* it). Safe here specifically because `virtual_path`
/// always comes from this module's own trusted history entries, never from
/// an external caller.
fn derived_real_path(work_dir: &Path, virtual_path: &str) -> PathBuf {
    let mut path = work_dir.to_path_buf();
    for segment in virtual_path
        .split('/')
        .filter(|segment| !segment.is_empty())
    {
        path.push(segment);
    }
    path
}

/// Deletes `virtual_path` if it currently exists; a no-op if it does not
/// (undoing a creation twice must not be an error).
fn delete_real_file_if_present(work_dir: &Path, virtual_path: &str) -> SlidraResult<()> {
    let real_path = match virtual_fs::resolve_virtual_file_path(work_dir, virtual_path) {
        Ok(path) => path,
        Err(SlidraError::NotFound(_)) => return Ok(()),
        Err(err) => return Err(err),
    };
    match std::fs::remove_file(&real_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        // real_path is a real filesystem path (ADR-0004) — never quote it.
        Err(_) => Err(SlidraError::invalid(format!(
            "error deleting file: {virtual_path}"
        ))),
    }
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
/// The snapshot files this group *consumes* are returned rather than
/// deleted here — the caller's `write_stack` has not run yet, so
/// `stack.json` on disk still lists this group as referencing them.
fn apply_group(
    home: &Path,
    id: &str,
    work_dir: &Path,
    group: &HistoryGroup,
) -> SlidraResult<ApplyGroupResult> {
    let mut inverse_entries = Vec::with_capacity(group.entries.len());
    for entry in &group.entries {
        let current = read_virtual_file_bytes_or_none(work_dir, &entry.virtual_path)?;
        match current {
            None => inverse_entries.push(HistoryEntry {
                virtual_path: entry.virtual_path.clone(),
                snapshot_id: None,
            }),
            Some(bytes) => {
                let inverse_snapshot_id = id::generate_opaque_id();
                write_snapshot(home, id, &inverse_snapshot_id, &bytes)?;
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
            None => delete_real_file_if_present(work_dir, &entry.virtual_path)?,
            Some(snapshot_id) => {
                let content = read_snapshot(home, id, snapshot_id)?;
                let real_path = derived_real_path(work_dir, &entry.virtual_path);
                (|| -> std::io::Result<()> {
                    if let Some(parent) = real_path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&real_path, &content)
                })()
                .map_err(|_| {
                    // real_path is a real filesystem path (ADR-0004) — never quote it.
                    SlidraError::invalid(format!("error writing slide: {}", entry.virtual_path))
                })?;
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
    let home = workspace::resolve_home();
    let work_dir = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&home, id)?;
    let group = stack
        .undo
        .pop()
        .ok_or_else(|| SlidraError::invalid("no operation to undo"))?;

    let ApplyGroupResult {
        inverse_group,
        restored_paths,
        consumed_snapshot_ids,
    } = apply_group(&home, id, &work_dir, &group)?;
    // No cap on this push — see UNDO_STACK_CAP's doc comment.
    stack.redo.push(inverse_group);
    write_stack(&home, id, &stack)?;

    // Only now is the new stack durable, so only now is it safe to delete
    // the snapshot files this undo consumed.
    for snapshot_id in &consumed_snapshot_ids {
        delete_snapshot(&home, id, snapshot_id)?;
    }
    Ok(UndoResult { restored_paths })
}

/// Redoes the most recently undone group, moving it back onto the undo
/// stack (subject to `UNDO_STACK_CAP`). The content redone is whatever was
/// on disk at the moment of the corresponding `undo` call, not a second
/// independently-tracked "future" — so a change made outside undo/redo
/// between the `undo` and this `redo` is what comes back.
pub fn redo(id: &str) -> SlidraResult<UndoResult> {
    let home = workspace::resolve_home();
    let work_dir = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&home, id)?;
    let group = stack
        .redo
        .pop()
        .ok_or_else(|| SlidraError::invalid("no operation to redo"))?;

    let ApplyGroupResult {
        inverse_group,
        restored_paths,
        consumed_snapshot_ids,
    } = apply_group(&home, id, &work_dir, &group)?;
    let evicted_snapshot_ids = push_group_to_undo_stack(&mut stack.undo, inverse_group);
    write_stack(&home, id, &stack)?;

    // Only now is the new stack durable, so only now is it safe to delete
    // the snapshot files this redo consumed, plus any cap-evicted group's.
    for snapshot_id in consumed_snapshot_ids
        .iter()
        .chain(evicted_snapshot_ids.iter())
    {
        delete_snapshot(&home, id, snapshot_id)?;
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
    let home = workspace::resolve_home();
    let work_dir = workspace::resolve_work_dir(id)?;
    let mut entries = Vec::with_capacity(virtual_paths.len());
    for &virtual_path in virtual_paths {
        let content = virtual_fs::read_virtual_file_bytes(&work_dir, virtual_path)?;
        let snapshot_id = id::generate_opaque_id();
        write_snapshot(&home, id, &snapshot_id, &content)?;
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
    let home = workspace::resolve_home();
    let mut stack = read_stack(&home, id)?;
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
        pending_deletion_snapshot_ids.extend(push_group_to_undo_stack(&mut stack.undo, group));
    }

    write_stack(&home, id, &stack)?;

    Ok(CommitResult {
        previous_stack,
        pending_deletion_snapshot_ids,
    })
}

/// Deletes the snapshot files a `commit_snapshot_entries` call orphaned,
/// once the caller knows that commit will never be reverted.
pub(crate) fn finalize_committed_entries(id: &str, snapshot_ids: &[String]) -> SlidraResult<()> {
    let home = workspace::resolve_home();
    for snapshot_id in snapshot_ids {
        delete_snapshot(&home, id, snapshot_id)?;
    }
    Ok(())
}

/// Deletes snapshot files staged by `stage_snapshot_entries` whose write was
/// never committed — the caller's actual content write failed, so these
/// would otherwise sit on disk unreferenced by any stack.
pub(crate) fn discard_snapshot_entries(id: &str, entries: &[HistoryEntry]) -> SlidraResult<()> {
    let home = workspace::resolve_home();
    for entry in entries {
        if let Some(snapshot_id) = &entry.snapshot_id {
            delete_snapshot(&home, id, snapshot_id)?;
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
    let home = workspace::resolve_home();
    write_stack(&home, id, previous_stack)?;
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
/// this module's are the same `stack.json` `openGroup`.
pub(crate) fn begin_history_group(id: &str) -> SlidraResult<bool> {
    let home = workspace::resolve_home();
    workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&home, id)?;
    if stack.open_group.is_some() {
        return Ok(false);
    }
    stack.open_group = Some(HistoryGroup {
        group_id: id::generate_opaque_id(),
        entries: Vec::new(),
    });
    write_stack(&home, id, &stack)?;
    Ok(true)
}

/// Closes the group opened by `begin_history_group` and pushes it onto the
/// undo stack as one step. An empty group (no command in it ever wrote
/// anything) is discarded rather than pushed, so an undo never lands on a
/// step that visibly does nothing. Called by each of `slide/ops.rs`'s six
/// multi-write operations, always paired with the `begin_history_group`
/// call that opened the group it closes — see that function's doc comment.
pub(crate) fn end_history_group(id: &str) -> SlidraResult<()> {
    let home = workspace::resolve_home();
    workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&home, id)?;
    let group = stack
        .open_group
        .take()
        .ok_or_else(|| SlidraError::invalid("no open undo group"))?;
    let evicted_snapshot_ids = if group.entries.is_empty() {
        Vec::new()
    } else {
        push_group_to_undo_stack(&mut stack.undo, group)
    };
    write_stack(&home, id, &stack)?;
    for snapshot_id in &evicted_snapshot_ids {
        delete_snapshot(&home, id, snapshot_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-history-{label}-{}",
            id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Registers `test_id -> work_dir` under `home/projects.json`, minimal
    /// shape `registry::lookup` needs. Built by hand (not `serde_json::json!`)
    /// because that macro treats a bare identifier key like `test_id` as the
    /// literal string `"test_id"`, not the variable's value — exactly the
    /// mistake this comment exists to head off after catching it once here.
    fn register(home: &Path, test_id: &str, work_dir: &Path) {
        let work_dir_json =
            serde_json::to_string(&work_dir.to_string_lossy().into_owned()).unwrap();
        let id_json = serde_json::to_string(test_id).unwrap();
        let json = format!(r#"{{{id_json}:{{"workDir":{work_dir_json}}}}}"#);
        std::fs::write(home.join("projects.json"), json).unwrap();
    }

    fn write_stack_json(home: &Path, test_id: &str, contents: &str) {
        let dir = history_dir_for(home, test_id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stack.json"), contents).unwrap();
    }

    fn write_snapshot_file(home: &Path, test_id: &str, snapshot_id: &str, content: &[u8]) {
        let dir = history_dir_for(home, test_id).join("snapshots");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(snapshot_id), content).unwrap();
    }

    struct Fixture {
        home: PathBuf,
        work: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str, test_id: &str) -> Self {
            let guard = workspace::registry::ENV_LOCK.lock().unwrap();
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
    fn undo_with_no_history_file_reports_nothing_to_undo() {
        let fixture = Fixture::new("no-file", "pid-no-file");
        let err = undo("pid-no-file").unwrap_err();
        // Missing stack.json must be treated as an empty stack (not
        // "corrupted"), so the observed error is the empty-undo-stack one.
        assert_eq!(err.message(), "no operation to undo");
        drop(fixture);
    }

    #[test]
    fn undo_then_redo_round_trips_exact_byte_content() {
        let fixture = Fixture::new("roundtrip", "pid-roundtrip");
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        let slide_path = fixture.work.join("slides").join("001.svg");
        std::fs::write(&slide_path, b"<svg>ORIGINAL</svg>").unwrap();

        write_snapshot_file(
            &fixture.home,
            "pid-roundtrip",
            "snap-before",
            b"<svg>BEFORE</svg>",
        );
        write_stack_json(
            &fixture.home,
            "pid-roundtrip",
            r#"{"undo":[{"groupId":"g1","entries":[{"virtualPath":"slides/001.svg","snapshotId":"snap-before"}]}],"redo":[],"openGroup":null}"#,
        );

        let undo_result = undo("pid-roundtrip").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(std::fs::read(&slide_path).unwrap(), b"<svg>BEFORE</svg>");
        // The consumed snapshot is deleted only after the stack.json write
        // that drops the last reference to it succeeds.
        assert!(
            !fixture
                .home
                .join("history/pid-roundtrip/snapshots/snap-before")
                .exists()
        );

        let redo_result = redo("pid-roundtrip").unwrap();
        assert_eq!(
            redo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(std::fs::read(&slide_path).unwrap(), b"<svg>ORIGINAL</svg>");

        drop(fixture);
    }

    #[test]
    fn undo_with_null_snapshot_id_deletes_the_file() {
        let fixture = Fixture::new("null-snapshot", "pid-null");
        std::fs::create_dir_all(fixture.work.join("assets")).unwrap();
        let asset_path = fixture.work.join("assets").join("new.png");
        std::fs::write(&asset_path, b"fresh import bytes").unwrap();

        write_stack_json(
            &fixture.home,
            "pid-null",
            r#"{"undo":[{"groupId":"g1","entries":[{"virtualPath":"assets/new.png","snapshotId":null}]}],"redo":[],"openGroup":null}"#,
        );

        let result = undo("pid-null").unwrap();
        assert_eq!(result.restored_paths, vec!["assets/new.png".to_string()]);
        assert!(!asset_path.exists());

        drop(fixture);
    }

    /// A path touched twice in one group must, after undo, end up at the
    /// state before its FIRST edit — the two-phase capture-then-reverse-
    /// apply order this test exists to pin down.
    #[test]
    fn group_with_same_virtual_path_twice_restores_pre_first_edit_state() {
        let fixture = Fixture::new("same-path-twice", "pid-twice");
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        let slide_path = fixture.work.join("slides").join("001.svg");
        // Current on-disk content: the state AFTER both edits.
        std::fs::write(&slide_path, b"V3-after-both-edits").unwrap();

        write_snapshot_file(
            &fixture.home,
            "pid-twice",
            "snap-v1",
            b"V1-before-first-edit",
        );
        write_snapshot_file(
            &fixture.home,
            "pid-twice",
            "snap-v2",
            b"V2-before-second-edit",
        );
        write_stack_json(
            &fixture.home,
            "pid-twice",
            r#"{"undo":[{"groupId":"g1","entries":[
                {"virtualPath":"slides/001.svg","snapshotId":"snap-v1"},
                {"virtualPath":"slides/001.svg","snapshotId":"snap-v2"}
            ]}],"redo":[],"openGroup":null}"#,
        );

        let result = undo("pid-twice").unwrap();
        // Deduped: one restored path even though the group has two entries
        // for it.
        assert_eq!(result.restored_paths, vec!["slides/001.svg".to_string()]);
        assert_eq!(std::fs::read(&slide_path).unwrap(), b"V1-before-first-edit");

        drop(fixture);
    }

    /// Pushing a 51st group onto the undo stack (here via `redo`, the only
    /// call site in this ported slice that can grow `undo` past one entry
    /// at a time under test control) drops the oldest group and deletes the
    /// snapshot file(s) it referenced.
    #[test]
    fn cap_evicts_oldest_undo_group_and_deletes_its_snapshot() {
        let fixture = Fixture::new("cap", "pid-cap");
        std::fs::create_dir_all(fixture.work.join("live")).unwrap();
        let live_path = fixture.work.join("live").join("001.svg");
        std::fs::write(&live_path, b"content-before-redo").unwrap();

        write_snapshot_file(&fixture.home, "pid-cap", "snap-u0", b"oldest-group-content");
        write_snapshot_file(&fixture.home, "pid-cap", "snap-r1", b"redo-content");

        let mut undo_groups = String::new();
        for i in 0..UNDO_STACK_CAP {
            if i > 0 {
                undo_groups.push(',');
            }
            let snapshot_field = if i == 0 {
                r#""snapshotId":"snap-u0""#.to_string()
            } else {
                "\"snapshotId\":null".to_string()
            };
            undo_groups.push_str(&format!(
                r#"{{"groupId":"u{i}","entries":[{{"virtualPath":"dummy/{i}.txt",{snapshot_field}}}]}}"#
            ));
        }
        let stack_json = format!(
            r#"{{"undo":[{undo_groups}],"redo":[{{"groupId":"r1","entries":[{{"virtualPath":"live/001.svg","snapshotId":"snap-r1"}}]}}],"openGroup":null}}"#
        );
        write_stack_json(&fixture.home, "pid-cap", &stack_json);

        let result = redo("pid-cap").unwrap();
        assert_eq!(result.restored_paths, vec!["live/001.svg".to_string()]);
        assert_eq!(std::fs::read(&live_path).unwrap(), b"redo-content");

        let stack_text = std::fs::read_to_string(stack_path(&fixture.home, "pid-cap")).unwrap();
        let stack_value: serde_json::Value = serde_json::from_str(&stack_text).unwrap();
        let undo_array = stack_value["undo"].as_array().unwrap();
        assert_eq!(undo_array.len(), UNDO_STACK_CAP);
        // Oldest group (u0) evicted; u1 is now the first entry.
        assert_eq!(undo_array[0]["groupId"], "u1");
        // The new inverse-of-redo group lands at the end, keeping r1's id.
        assert_eq!(undo_array[UNDO_STACK_CAP - 1]["groupId"], "r1");

        // Evicted group's snapshot is gone; the redo's own consumed
        // snapshot is gone too.
        assert!(
            !fixture
                .home
                .join("history/pid-cap/snapshots/snap-u0")
                .exists()
        );
        assert!(
            !fixture
                .home
                .join("history/pid-cap/snapshots/snap-r1")
                .exists()
        );

        drop(fixture);
    }

    #[test]
    fn corrupted_stack_json_is_reported_as_damaged_history() {
        let fixture = Fixture::new("corrupt-syntax", "pid-corrupt-1");
        write_stack_json(&fixture.home, "pid-corrupt-1", "{not valid json");
        let err = undo("pid-corrupt-1").unwrap_err();
        assert_eq!(err.message(), "undo history is corrupted");
        drop(fixture);
    }

    #[test]
    fn wrong_shaped_stack_json_is_reported_as_damaged_history() {
        let fixture = Fixture::new("corrupt-shape", "pid-corrupt-2");
        // Valid JSON, wrong shape: `undo` is not an array.
        write_stack_json(
            &fixture.home,
            "pid-corrupt-2",
            r#"{"undo":"nope","redo":[],"openGroup":null}"#,
        );
        let err = undo("pid-corrupt-2").unwrap_err();
        assert_eq!(err.message(), "undo history is corrupted");
        drop(fixture);
    }

    #[test]
    fn stack_json_referencing_a_missing_snapshot_file_is_damaged_history() {
        let fixture = Fixture::new("missing-snapshot", "pid-missing-snap");
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        std::fs::write(fixture.work.join("slides").join("001.svg"), b"current").unwrap();
        // References a snapshot id whose file was never written.
        write_stack_json(
            &fixture.home,
            "pid-missing-snap",
            r#"{"undo":[{"groupId":"g1","entries":[{"virtualPath":"slides/001.svg","snapshotId":"never-written"}]}],"redo":[],"openGroup":null}"#,
        );
        let err = undo("pid-missing-snap").unwrap_err();
        assert_eq!(err.message(), "undo history is corrupted");
        drop(fixture);
    }

    // --- Write-path staging API ---------------------------------------

    #[test]
    fn stage_commit_finalize_round_trips_through_undo() {
        let fixture = Fixture::new("stage-commit", "pid-stage-commit");
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        let slide_path = fixture.work.join("slides").join("001.svg");
        std::fs::write(&slide_path, b"<svg>BEFORE</svg>").unwrap();

        // Simulates write_presentation_file's stage -> commit -> write ->
        // finalize sequence (commit BEFORE the content write, per NOOP-337).
        let entries = stage_snapshot_entries("pid-stage-commit", &["slides/001.svg"]).unwrap();
        let CommitResult {
            pending_deletion_snapshot_ids,
            ..
        } = commit_snapshot_entries("pid-stage-commit", entries).unwrap();
        std::fs::write(&slide_path, b"<svg>AFTER</svg>").unwrap();
        finalize_committed_entries("pid-stage-commit", &pending_deletion_snapshot_ids).unwrap();

        // Exactly one undo step was occupied, and it restores the pre-write
        // content.
        let result = undo("pid-stage-commit").unwrap();
        assert_eq!(result.restored_paths, vec!["slides/001.svg".to_string()]);
        assert_eq!(std::fs::read(&slide_path).unwrap(), b"<svg>BEFORE</svg>");
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
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        let slide_path = fixture.work.join("slides").join("001.svg");
        std::fs::write(&slide_path, b"<svg>ORIGINAL</svg>").unwrap();

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
        assert_eq!(std::fs::read(&slide_path).unwrap(), b"<svg>ORIGINAL</svg>");

        drop(fixture);
    }

    /// A commit clears the redo stack; a subsequent revert restores it
    /// verbatim (NOOP-333 Fix.7r2) rather than merely undoing the group it
    /// pushed.
    #[test]
    fn revert_restores_a_redo_stack_the_commit_had_cleared() {
        let fixture = Fixture::new("revert-redo", "pid-revert-redo");
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        std::fs::write(fixture.work.join("slides").join("001.svg"), b"current").unwrap();
        write_snapshot_file(&fixture.home, "pid-revert-redo", "snap-r1", b"redo-content");
        write_stack_json(
            &fixture.home,
            "pid-revert-redo",
            r#"{"undo":[],"redo":[{"groupId":"r1","entries":[{"virtualPath":"slides/001.svg","snapshotId":"snap-r1"}]}],"openGroup":null}"#,
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
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        let slide_path = fixture.work.join("slides").join("001.svg");
        std::fs::write(&slide_path, b"<svg>BEFORE</svg>").unwrap();

        record_snapshot("pid-record", &["slides/001.svg"]).unwrap();
        std::fs::write(&slide_path, b"<svg>AFTER</svg>").unwrap();

        let result = undo("pid-record").unwrap();
        assert_eq!(result.restored_paths, vec!["slides/001.svg".to_string()]);
        assert_eq!(std::fs::read(&slide_path).unwrap(), b"<svg>BEFORE</svg>");

        drop(fixture);
    }

    #[test]
    fn discard_snapshot_entries_removes_unreferenced_staged_files() {
        let fixture = Fixture::new("discard", "pid-discard");
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        std::fs::write(fixture.work.join("slides").join("001.svg"), b"content").unwrap();

        let entries = stage_snapshot_entries("pid-discard", &["slides/001.svg"]).unwrap();
        let snapshot_id = entries[0].snapshot_id.clone().unwrap();
        assert!(
            fixture
                .home
                .join("history/pid-discard/snapshots")
                .join(&snapshot_id)
                .exists()
        );

        discard_snapshot_entries("pid-discard", &entries).unwrap();
        assert!(
            !fixture
                .home
                .join("history/pid-discard/snapshots")
                .join(&snapshot_id)
                .exists()
        );

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
        std::fs::create_dir_all(fixture.work.join("slides")).unwrap();
        let slide_a = fixture.work.join("slides").join("001.svg");
        let slide_b = fixture.work.join("slides").join("002.svg");
        std::fs::write(&slide_a, b"A-before").unwrap();
        std::fs::write(&slide_b, b"B-before").unwrap();

        let opened = begin_history_group("pid-group").unwrap();
        assert!(opened, "first caller must open the group");
        assert!(
            !begin_history_group("pid-group").unwrap(),
            "a second caller joins rather than re-opening"
        );

        let entries_a = stage_snapshot_entries("pid-group", &["slides/001.svg"]).unwrap();
        commit_snapshot_entries("pid-group", entries_a).unwrap();
        std::fs::write(&slide_a, b"A-after").unwrap();

        let entries_b = stage_snapshot_entries("pid-group", &["slides/002.svg"]).unwrap();
        commit_snapshot_entries("pid-group", entries_b).unwrap();
        std::fs::write(&slide_b, b"B-after").unwrap();

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
        assert_eq!(std::fs::read(&slide_a).unwrap(), b"A-before");
        assert_eq!(std::fs::read(&slide_b).unwrap(), b"B-before");
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
