// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Workspace write paths. `write_presentation_file`
//! (the one door every content-writing command goes through),
//! `assert_slide_path_listed` (the widened slide-or-template membership
//! check every one of them opens with), and the per-presentation clipboard
//! file's raw I/O are additions on top of the original engine's write half.
//! `write_presentation_file_without_history` (`presentation canvas set`'s
//! one exception door), `create_presentation_file` (`slide add`/`template
//! add`'s new-file door), and `delete_presentation_file` (`slide delete`/
//! `template delete`'s door) predate these additions and are carried
//! over unchanged in spirit — every content-writing command in this crate
//! routes through one of these doors, so undo/redo is free (`history.rs`'s
//! staging API) without each command writing its own inverse logic.
//! `workspace/mod.rs`'s doc comment ("This module WRITES NOTHING") predates
//! all of this — see this file for the write path that comment now points to.
//!
//! Bundles the four-step boilerplate every one of the original CLI's
//! per-command write wrappers (`setElementText`, `addTextBox`, `insertSlideElement`, ...)
//! repeats verbatim — resolve the deck, confirm the file exists,
//! confirm it's a listed slide/template, read it — into one `require_slide`
//! call, so these ~19 `element`/`text`/`textbox` command handlers
//! don't each hand-roll the same four lines.

use crate::errors::{SlidraError, SlidraResult};
use crate::history;
use crate::workspace::project::{self, ProjectJson};
use crate::workspace::virtual_fs;
use crate::workspace::{self};
use std::path::{Path, PathBuf};

/// A slide (or template) resolved and read, ready for a pure mutation
/// function to transform. Bundles what `require_slide` had to look up along
/// the way — `work_dir` (the deck's own file path, needed again by
/// `write_presentation_file`) and `project` (some commands, e.g. `element
/// style set`'s table-container check, need more of it than just
/// membership) — so a caller never has to re-derive either.
#[derive(Debug)]
pub struct RequiredSlide {
    pub work_dir: PathBuf,
    pub project: ProjectJson,
    pub content: String,
}

/// Confirms `virtual_path` is one of the presentation's declared slides OR
/// templates (ADR-0013 widened this from slides-only), returning the parsed
/// `project.json` so the caller doesn't read it twice. `comment *`'s own,
/// narrower "slides only, no templates" rule (plan section 3.7 / 4 table E)
/// is intentionally NOT this function — it lives next to `commands::comment`
/// as its own tiny check, mirroring `slide-ops.ts`'s local `requireSlidePath`
/// being a distinct, narrower function from this one (`workspace.ts`'s
/// `assertSlidePathListed`), not a parameterization of it.
pub fn assert_slide_path_listed(work_dir: &Path, virtual_path: &str) -> SlidraResult<ProjectJson> {
    let project = project::read_project_json(work_dir)?;
    let templates = project::read_template_entries(&project);
    let is_slide = project.slides.iter().any(|slide| slide == virtual_path);
    let is_template = templates
        .iter()
        .any(|template| template.file == virtual_path);
    if !is_slide && !is_template {
        return Err(SlidraError::invalid(format!("not a slide: {virtual_path}")));
    }
    Ok(project)
}

/// Resolves, membership-checks, and reads one slide/template — the shared
/// first step of every `element`/`text`/`textbox` command handler. Order
/// matters and is preserved from the TS original: a missing real file is
/// reported before "not a slide" (`workspace.ts:521-522`'s comment), and
/// both are reported before the file is ever read.
pub fn require_slide(id: &str, slide_path: &str) -> SlidraResult<RequiredSlide> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::assert_file_exists(&work_dir, slide_path)?;
    let project = assert_slide_path_listed(&work_dir, slide_path)?;
    let content = virtual_fs::read_virtual_file(&work_dir, slide_path)?;
    Ok(RequiredSlide {
        work_dir,
        project,
        content,
    })
}

/// The single door every content-writing command must use. Snapshots the file's current content
/// into undo history before overwriting it, so any command that writes
/// through here gets undo for free without writing its own inverse logic.
///
/// The undo group is committed BEFORE the content write itself (not after —
/// see `history::commit_snapshot_entries`'s doc for why): a caller that
/// polls with a fixed delay after issuing a command could otherwise observe
/// the new content on disk before the commit that makes `undo` recognize
/// it, and see `undo` reject with "no operation to undo" even though the edit it
/// means to revert is already visible. If the content write itself then
/// fails, the commit is unwound (`revert_committed_entries`) — a failed
/// command must not occupy an undo slot, and it must not leave an orphan
/// snapshot file either.
pub fn write_presentation_file(id: &str, virtual_path: &str, content: &str) -> SlidraResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::assert_file_exists(&work_dir, virtual_path)?;
    let entries = history::stage_snapshot_entries(id, &[virtual_path])?;
    let history::CommitResult {
        previous_stack,
        pending_deletion_snapshot_ids,
    } = history::commit_snapshot_entries(id, entries.clone())?;

    match virtual_fs::write_existing_file(&work_dir, virtual_path, content.as_bytes()) {
        Ok(()) => {
            history::finalize_committed_entries(id, &pending_deletion_snapshot_ids)?;
            Ok(())
        }
        Err(_) => {
            history::revert_committed_entries(id, &entries, &previous_stack)?;
            Err(SlidraError::invalid(format!(
                "error writing slide: {virtual_path}"
            )))
        }
    }
}

/// The one exception door: only `presentation canvas set` (F3's command)
/// uses this — page size never occupies an undo step. No snapshot/commit
/// bracket at all, so nothing is pushed onto the undo stack.
pub fn write_presentation_file_without_history(
    id: &str,
    virtual_path: &str,
    content: &str,
) -> SlidraResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::write_existing_file(&work_dir, virtual_path, content.as_bytes())
        .map_err(|_| SlidraError::invalid(format!("error writing slide: {virtual_path}")))
}

/// Writes `content` to a virtual path that must not already exist — the
/// creation counterpart to `write_presentation_file` (`slide add`/
/// `template add`'s new file). Undo for a created file deletes it instead of
/// restoring prior content (`history::stage_new_file_entry`).
pub fn create_presentation_file(id: &str, virtual_path: &str, content: &[u8]) -> SlidraResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    let already_exists = virtual_fs::assert_file_exists(&work_dir, virtual_path).is_ok();
    if already_exists {
        return Err(SlidraError::invalid(format!(
            "file already exists: {virtual_path}"
        )));
    }

    let entry = history::stage_new_file_entry(virtual_path);
    let write_result = virtual_fs::create_new_file(&work_dir, virtual_path, content);
    if write_result.is_err() {
        history::discard_snapshot_entries(id, std::slice::from_ref(&entry))?;
        return Err(SlidraError::invalid(format!(
            "error writing file: {virtual_path}"
        )));
    }
    let commit = history::commit_snapshot_entries(id, vec![entry])?;
    history::finalize_committed_entries(id, &commit.pending_deletion_snapshot_ids)?;
    Ok(())
}

/// Deletes an existing virtual path (`slide delete`/`template delete`). The
/// deletion counterpart to `write_presentation_file`: the file's current
/// content is snapshotted first, so undo restores it exactly.
pub fn delete_presentation_file(id: &str, virtual_path: &str) -> SlidraResult<()> {
    let work_dir = workspace::resolve_work_dir(id)?;
    virtual_fs::assert_file_exists(&work_dir, virtual_path)?;
    let entries = history::stage_snapshot_entries(id, &[virtual_path])?;
    match virtual_fs::delete_file(&work_dir, virtual_path) {
        Ok(()) => {
            let commit = history::commit_snapshot_entries(id, entries)?;
            history::finalize_committed_entries(id, &commit.pending_deletion_snapshot_ids)?;
            Ok(())
        }
        Err(_) => {
            history::discard_snapshot_entries(id, &entries)?;
            Err(SlidraError::invalid(format!(
                "error deleting file: {virtual_path}"
            )))
        }
    }
}

/// `<SLIDRA_HOME>/clipboard/<presentationId>.json` — sibling to
/// `history/<id>/`, outside the working directory (packing the working dir
/// into `.slidra` must never leak clipboard contents). Per-id filing is the
/// entire mechanism enforcing "same presentation only".
fn clipboard_file_path(home: &Path, id: &str) -> PathBuf {
    home.join("clipboard").join(format!("{id}.json"))
}

/// Reads the presentation's clipboard file's raw text. Returns `Err` with
/// "clipboard is empty" when the file has never been written (ENOENT) — the
/// caller (`element paste`, P7) is what turns that into a `Failed`
/// `CommandResult`. JSON-parsing the text into a typed payload, and the
/// "clipboard data is corrupted" error a parse failure produces, is deliberately NOT
/// this function's job — it belongs to whichever typed payload shape reads
/// it (`element::clipboard::ClipboardPayload`, P7), which this ticket's
/// foundation phase does not yet define.
pub fn read_clipboard_file(id: &str) -> SlidraResult<String> {
    let home = workspace::resolve_home();
    match std::fs::read_to_string(clipboard_file_path(&home, id)) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(SlidraError::invalid("clipboard is empty"))
        }
        Err(_) => Err(SlidraError::invalid("failed to read clipboard")),
    }
}

/// Writes `contents` (already-serialized JSON) to the presentation's
/// clipboard file, creating the `clipboard/` directory on first use. Never
/// touches undo history — the clipboard file is not presentation content.
pub fn write_clipboard_file(id: &str, contents: &str) -> SlidraResult<()> {
    let home = workspace::resolve_home();
    let dir = home.join("clipboard");
    std::fs::create_dir_all(&dir)
        .map_err(|_| SlidraError::invalid("failed to write to clipboard"))?;
    std::fs::write(clipboard_file_path(&home, id), contents)
        .map_err(|_| SlidraError::invalid("failed to write to clipboard"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-write-{label}-{}",
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
        /// Builds a deck holding a slide and a template with known
        /// content, registers it under a fresh `SLIDRA_HOME` as `test_id`.
        fn new(label: &str, test_id: &str) -> Self {
            let guard = workspace::registry::ENV_LOCK.lock().unwrap();
            let home = temp_dir(&format!("{label}-home"));
            let deck = crate::deck::build_test_deck(
                label,
                &[
                    (
                        "project.json",
                        br#"{"formatVersion":5,"name":"P","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"templates":["templates/001.svg"]}"#,
                    ),
                    ("slides/001.svg", b"<svg>ORIGINAL</svg>"),
                    ("templates/001.svg", b"<svg>TEMPLATE</svg>"),
                ],
            );
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
    fn assert_slide_path_listed_accepts_both_slides_and_templates() {
        let fixture = Fixture::new("listed", "pid-listed");
        assert!(assert_slide_path_listed(&fixture.deck, "slides/001.svg").is_ok());
        assert!(assert_slide_path_listed(&fixture.deck, "templates/001.svg").is_ok());
        let err = assert_slide_path_listed(&fixture.deck, "project.json").unwrap_err();
        assert_eq!(err.message(), "not a slide: project.json");
        drop(fixture);
    }

    #[test]
    fn require_slide_reports_a_missing_real_file_before_not_a_slide() {
        let fixture = Fixture::new("missing-real-file", "pid-missing-real");

        let err = require_slide("pid-missing-real", "slides/999.svg").unwrap_err();
        // `assert_file_exists`'s "file not found" error, not
        // `assert_slide_path_listed`'s "not a slide" — proves the
        // existence check ran first.
        assert_eq!(err.message(), "file not found: slides/999.svg");

        drop(fixture);
    }

    #[test]
    fn write_presentation_file_round_trips_through_undo() {
        let fixture = Fixture::new("write-roundtrip", "pid-write-roundtrip");

        let slide = require_slide("pid-write-roundtrip", "slides/001.svg").unwrap();
        assert_eq!(slide.content, "<svg>ORIGINAL</svg>");
        write_presentation_file("pid-write-roundtrip", "slides/001.svg", "<svg>EDITED</svg>")
            .unwrap();
        assert_eq!(
            virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg").unwrap(),
            "<svg>EDITED</svg>"
        );

        let undo_result = history::undo("pid-write-roundtrip").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(
            virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg").unwrap(),
            "<svg>ORIGINAL</svg>"
        );

        drop(fixture);
    }

    #[test]
    fn write_presentation_file_failure_reverts_the_undo_group_and_leaves_no_orphan_snapshot() {
        // Removing the `revert_committed_entries` call in
        // `write_presentation_file` left 291 tests green — nothing
        // exercised the "commit succeeded, the actual write then failed"
        // branch. [E6.T6]: history storage now lives in the SAME deck file
        // as `content`, so a chmod-read-only deck (the pre-[E6.T6] trigger)
        // would fail `stage_snapshot_entries`'s own write too, never
        // reaching the branch under test. A `content`-only `BEFORE UPDATE`
        // trigger is the surgical replacement: schema-level, so it fires
        // for every connection regardless of which one opens next, and it
        // only blocks the `UPDATE content ...` `write_existing_file` issues
        // — every `history_group`/`history_entry`/`history_snapshot`
        // INSERT/DELETE `stage_snapshot_entries`/`commit_snapshot_entries`
        // issue is untouched.
        let fixture = Fixture::new("write-fail", "pid-write-fail");
        {
            let conn = rusqlite::Connection::open(&fixture.deck).unwrap();
            conn.execute_batch(
                "CREATE TRIGGER block_content_write BEFORE UPDATE ON content \
                 BEGIN SELECT RAISE(ABORT, 'blocked for test'); END;",
            )
            .unwrap();
        }

        let write_result =
            write_presentation_file("pid-write-fail", "slides/001.svg", "<svg>EDITED</svg>");

        let err = write_result.unwrap_err();
        assert_eq!(err.message(), "error writing slide: slides/001.svg");
        assert_eq!(
            virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg").unwrap(),
            "<svg>ORIGINAL</svg>",
            "a failed write must not have touched the file's content"
        );

        let undo_err = history::undo("pid-write-fail").unwrap_err();
        assert_eq!(
            undo_err.message(),
            "no operation to undo",
            "the failed write must not occupy an undo slot"
        );

        let conn = rusqlite::Connection::open(&fixture.deck).unwrap();
        let orphan_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM history_snapshot", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            orphan_count, 0,
            "a reverted commit must not leave an orphan snapshot row behind"
        );

        drop(fixture);
    }

    #[test]
    fn write_presentation_file_without_history_does_not_occupy_undo_step() {
        let fixture = Fixture::new("write-no-history", "pid-write-no-history");

        write_presentation_file_without_history(
            "pid-write-no-history",
            "slides/001.svg",
            "<svg>EDITED</svg>",
        )
        .unwrap();
        assert_eq!(
            virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg").unwrap(),
            "<svg>EDITED</svg>"
        );

        let err = history::undo("pid-write-no-history").unwrap_err();
        assert_eq!(err.message(), "no operation to undo");

        drop(fixture);
    }

    #[test]
    fn create_presentation_file_rejects_existing_path_and_undo_deletes_a_created_one() {
        let fixture = Fixture::new("create", "pid-create");

        let err = create_presentation_file("pid-create", "slides/001.svg", b"Y").unwrap_err();
        assert_eq!(err.message(), "file already exists: slides/001.svg");

        create_presentation_file("pid-create", "assets/new.png", b"\x89PNG").unwrap();
        assert_eq!(
            virtual_fs::read_virtual_file_bytes(&fixture.deck, "assets/new.png").unwrap(),
            b"\x89PNG"
        );

        let undo_result = history::undo("pid-create").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["assets/new.png".to_string()]
        );
        assert!(virtual_fs::assert_file_exists(&fixture.deck, "assets/new.png").is_err());

        drop(fixture);
    }

    #[test]
    fn delete_presentation_file_removes_and_undo_restores() {
        let fixture = Fixture::new("delete", "pid-delete");

        delete_presentation_file("pid-delete", "slides/001.svg").unwrap();
        assert!(virtual_fs::assert_file_exists(&fixture.deck, "slides/001.svg").is_err());

        let undo_result = history::undo("pid-delete").unwrap();
        assert_eq!(
            undo_result.restored_paths,
            vec!["slides/001.svg".to_string()]
        );
        assert_eq!(
            virtual_fs::read_virtual_file(&fixture.deck, "slides/001.svg").unwrap(),
            "<svg>ORIGINAL</svg>"
        );

        drop(fixture);
    }

    #[test]
    fn clipboard_file_round_trips_and_missing_file_is_reported_as_empty() {
        let fixture = Fixture::new("clipboard", "pid-clipboard");
        let err = read_clipboard_file("pid-clipboard").unwrap_err();
        assert_eq!(err.message(), "clipboard is empty");

        write_clipboard_file("pid-clipboard", r#"{"sourceSlidePath":"slides/001.svg"}"#).unwrap();
        let read_back = read_clipboard_file("pid-clipboard").unwrap();
        assert_eq!(read_back, r#"{"sourceSlidePath":"slides/001.svg"}"#);

        drop(fixture);
    }
}
