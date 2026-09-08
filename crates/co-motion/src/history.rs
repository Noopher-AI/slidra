//! Undo/redo for presentation content. Ported from
//! `packages/core/src/history.ts`, scoped to this ticket's "undo/redo stack
//! semantics" slice only: `stack.json`/`snapshots/` storage, and the
//! `undo`/`redo` commands themselves. The TS file's *write-path* staging API
//! (`stageSnapshotEntries`/`commitSnapshotEntries`/`discardSnapshotEntries`/
//! `finalizeCommittedEntries`/`revertCommittedEntries`/`beginHistoryGroup`/
//! `endHistoryGroup`/`recordSnapshot`) belongs to the content-editing command
//! layer (`writePresentationFile` and friends), which is not yet ported to
//! Rust — there is nothing here for those commands to call into yet, so
//! porting that half now would be dead code with no caller. See the final
//! report's "spec requires but not done" note.
//!
//! Storage lives at `<CO_MOTION_HOME>/history/<presentation-id>/`, a sibling
//! of `work/<id>/` under the same home — never inside the work directory
//! itself. It is a snapshot store, not an inverse-operation log: an entry is
//! the complete prior content of one changed file, addressed only by its
//! virtual path and presentation id (ADR-0004) — this module has no idea
//! what a slide or an element is.
//!
//! Public API:
//! - `undo(id) -> CoMotionResult<UndoResult>` — undoes the most recent
//!   group, moving it onto the redo stack.
//! - `redo(id) -> CoMotionResult<UndoResult>` — redoes the most recently
//!   undone group, moving it back onto the undo stack (subject to the same
//!   `UNDO_STACK_CAP` as any other push onto that stack).
//!
//! Both take only `id` (not `work_dir`/`history_dir` explicitly) and resolve
//! `CO_MOTION_HOME` plus the work directory themselves via `crate::workspace`
//! — mirroring `undoLastGroup`/`redoLastGroup`'s actual TS signatures
//! (`(id: string)`, internally calling `resolveCoMotionHome`/
//! `resolveWorkDir`) rather than pushing that resolution onto every call
//! site. A CLI command handler for `co-motion undo`/`redo` needs only the
//! presentation id argv already gives it.

use crate::errors::{CoMotionError, CoMotionResult};
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
struct HistoryEntry {
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
struct StackFile {
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
/// entry missing `virtualPath`, ...) — is a loud `CoMotionError`, never a
/// silent fallback to empty. All three of those failure modes collapse to
/// the same message (`復原歷史已損毀`), matching the TS original exactly —
/// this is a *narrower* set of distinct messages than `workspace.ts`'s
/// `readRegistry` uses for its analogous cases, not an inconsistency.
///
/// `openGroup` (a previous turn left an edit group open without closing it)
/// is read and round-tripped by `write_stack`, but never inspected or
/// validated beyond "present and either null or a well-formed group" by
/// `undo`/`redo` — they operate purely on the `undo`/`redo` arrays.
fn read_stack(home: &Path, id: &str) -> CoMotionResult<StackFile> {
    let raw = match std::fs::read_to_string(stack_path(home, id)) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StackFile {
                undo: Vec::new(),
                redo: Vec::new(),
                open_group: None,
            });
        }
        Err(_) => return Err(CoMotionError::invalid("復原歷史已損毀")),
    };
    serde_json::from_str(&raw).map_err(|_| CoMotionError::invalid("復原歷史已損毀"))
}

/// Atomic write: temp file + rename. Every step (directory creation
/// included) is wrapped so a raw I/O error can never escape this module with
/// a real filesystem path in its message (ADR-0004). On any failure, the
/// temp file is best-effort removed rather than left behind.
fn write_stack(home: &Path, id: &str, stack: &StackFile) -> CoMotionResult<()> {
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
        return Err(CoMotionError::invalid("無法寫入復原歷史"));
    }
    Ok(())
}

/// Writes one snapshot file, as raw bytes — this module has no idea whether
/// `content` is UTF-8 text or a binary asset's original bytes, so neither
/// ever goes through a decode/re-encode round trip that could alter it.
fn write_snapshot(home: &Path, id: &str, snapshot_id: &str, content: &[u8]) -> CoMotionResult<()> {
    let file_path = snapshot_path(home, id, snapshot_id);
    (|| -> std::io::Result<()> {
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&file_path, content)
    })()
    .map_err(|_| CoMotionError::invalid("無法寫入復原快照"))
}

/// `stack.json` still points at a snapshot file that is no longer there is
/// always a hard error here — never skip the entry and pretend the group is
/// smaller than it is.
fn read_snapshot(home: &Path, id: &str, snapshot_id: &str) -> CoMotionResult<Vec<u8>> {
    std::fs::read(snapshot_path(home, id, snapshot_id))
        .map_err(|_| CoMotionError::invalid("復原歷史已損毀"))
}

/// Deletes one snapshot file. A file that is already gone is not an error
/// (mirrors Node's `rm(..., { force: true })`); any other failure (e.g. a
/// permission error) is a real problem and must not be swallowed.
fn delete_snapshot(home: &Path, id: &str, snapshot_id: &str) -> CoMotionResult<()> {
    match std::fs::remove_file(snapshot_path(home, id, snapshot_id)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(CoMotionError::invalid("無法刪除復原快照")),
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
) -> CoMotionResult<Option<Vec<u8>>> {
    match virtual_fs::read_virtual_file_bytes(work_dir, virtual_path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(CoMotionError::NotFound(_)) => Ok(None),
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
fn delete_real_file_if_present(work_dir: &Path, virtual_path: &str) -> CoMotionResult<()> {
    let real_path = match virtual_fs::resolve_virtual_file_path(work_dir, virtual_path) {
        Ok(path) => path,
        Err(CoMotionError::NotFound(_)) => return Ok(()),
        Err(err) => return Err(err),
    };
    match std::fs::remove_file(&real_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        // real_path is a real filesystem path (ADR-0004) — never quote it.
        Err(_) => Err(CoMotionError::invalid(format!(
            "刪除檔案時發生錯誤：{virtual_path}"
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
) -> CoMotionResult<ApplyGroupResult> {
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
                    CoMotionError::invalid(format!("寫入投影片時發生錯誤：{}", entry.virtual_path))
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
pub fn undo(id: &str) -> CoMotionResult<UndoResult> {
    let home = workspace::resolve_home();
    let work_dir = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&home, id)?;
    let group = stack
        .undo
        .pop()
        .ok_or_else(|| CoMotionError::invalid("沒有可復原的操作"))?;

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
pub fn redo(id: &str) -> CoMotionResult<UndoResult> {
    let home = workspace::resolve_home();
    let work_dir = workspace::resolve_work_dir(id)?;
    let mut stack = read_stack(&home, id)?;
    let group = stack
        .redo
        .pop()
        .ok_or_else(|| CoMotionError::invalid("沒有可重做的操作"))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "co-motion-test-history-{label}-{}",
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
    fn undo_with_no_history_file_reports_nothing_to_undo() {
        let fixture = Fixture::new("no-file", "pid-no-file");
        let err = undo("pid-no-file").unwrap_err();
        // Missing stack.json must be treated as an empty stack (not
        // "corrupted"), so the observed error is the empty-undo-stack one.
        assert_eq!(err.message(), "沒有可復原的操作");
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
        assert_eq!(err.message(), "復原歷史已損毀");
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
        assert_eq!(err.message(), "復原歷史已損毀");
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
        assert_eq!(err.message(), "復原歷史已損毀");
        drop(fixture);
    }
}
