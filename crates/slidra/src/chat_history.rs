// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Chat history storage: a `chat_history` table living inside the same
//! `.slidra` SQLite deck `deck.rs` opens — so a conversation travels with
//! the file itself (copy the deck, copy the conversation), and reopening a
//! deck later reads the same history back. `CREATE TABLE IF NOT EXISTS`
//! rather than a `deck.rs` `SCHEMA_SQL`/`FORMAT_VERSION` bump: this table is
//! additive and every other wave-2 ticket adding its own table does the
//! same, so none of them collide on a shared schema/migration edit
//! (`commands::chat_history`'s module doc has the full rationale).
//!
//! `query()` never creates the table (see its own doc) — only
//! `append_entries()` does, the first time a conversation actually writes
//! anything. A deck nobody has chatted in yet stays byte-for-byte what
//! `deck.rs`/`virtual_fs.rs` produced; a pure read must never be the thing
//! that first mutates it.

use crate::deck;
use crate::errors::{SlidraError, SlidraResult};
use crate::workspace;
use rusqlite::{Connection, OptionalExtension, params};

/// The only four kinds a chat entry may carry — validated on every
/// `append_entries` call, never trusted from the caller. `author`/`agent`
/// mirror who spoke, `command` is a `slidra` invocation the agent ran (its
/// outcome folded into the same row via the upsert below), `divider` marks
/// an agent switch or a "New chat" reset. `error`/`notice` are deliberately
/// absent: those describe one browser connection's own SSE session, not a
/// fact about the presentation (plan §2 scope boundary).
pub const VALID_KINDS: &[&str] = &["author", "agent", "command", "divider"];

/// One row of `chat_history`. `meta` carries the fields specific to a
/// `command` entry (`toolCallId`/`status`/`cli`/`output`/`blocked`) as an
/// opaque JSON object — never inspected by this module, only stored and
/// handed back; `commands::chat_history` flattens it into the CLI's JSON
/// envelope. `seq` is the table's own autoincrement id: callers building an
/// entry to append leave it at `0` (ignored by `append_entries`, which never
/// writes to that column); `query()` always fills in the real value.
#[derive(Debug, Clone)]
pub struct ChatEntry {
    pub seq: i64,
    pub entry_id: String,
    pub kind: String,
    pub at: String,
    pub text: String,
    pub meta: Option<serde_json::Value>,
}

const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS chat_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    text TEXT NOT NULL,
    meta TEXT
)";

fn io_err(_: rusqlite::Error) -> SlidraError {
    SlidraError::invalid("error reading chat history")
}

fn open(id: &str) -> SlidraResult<Connection> {
    let deck_path = workspace::resolve_work_dir(id)?;
    deck::open_connection(&deck_path)
        .map_err(|_| SlidraError::invalid("error reading chat history"))
}

fn table_exists(conn: &Connection) -> SlidraResult<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_history'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(io_err)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatEntry> {
    let meta_raw: Option<String> = row.get(5)?;
    let meta = meta_raw.and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(ChatEntry {
        seq: row.get(0)?,
        entry_id: row.get(1)?,
        kind: row.get(2)?,
        at: row.get(3)?,
        text: row.get(4)?,
        meta,
    })
}

/// Writes `entries` in one transaction — either all of them land or none do
/// (a batch with one invalid kind/entryId writes nothing, matching
/// `commands::chat_history`'s "stdin batch is all-or-nothing" contract).
/// Each entry upserts on `entry_id`: a second `append_entries` call carrying
/// an id already in the table updates that same row's `kind`/`at`/`text`/
/// `meta` in place rather than inserting a duplicate — `seq` (and so
/// position in `query()`'s output) never changes, which is what lets a
/// command's `pending` row be updated in place to `completed` once its
/// outcome is known, without the command appearing to move in the
/// conversation.
pub fn append_entries(id: &str, entries: &[ChatEntry]) -> SlidraResult<usize> {
    for entry in entries {
        if entry.entry_id.is_empty() {
            return Err(SlidraError::invalid("chat entry missing entryId"));
        }
        if !VALID_KINDS.contains(&entry.kind.as_str()) {
            return Err(SlidraError::invalid(format!(
                "invalid chat entry kind: {}",
                entry.kind
            )));
        }
    }
    if entries.is_empty() {
        return Ok(0);
    }

    let mut conn = open(id)?;
    conn.execute(SCHEMA_SQL, []).map_err(io_err)?;
    let tx = conn.transaction().map_err(io_err)?;
    for entry in entries {
        let meta_json = entry.meta.as_ref().map(|value| value.to_string());
        tx.execute(
            "INSERT INTO chat_history (entry_id, kind, at, text, meta) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(entry_id) DO UPDATE SET
               kind = excluded.kind,
               at = excluded.at,
               text = excluded.text,
               meta = excluded.meta",
            params![entry.entry_id, entry.kind, entry.at, entry.text, meta_json],
        )
        .map_err(io_err)?;
    }
    tx.commit().map_err(io_err)?;
    Ok(entries.len())
}

/// Reads back at most `limit` entries, oldest to newest, optionally
/// filtered to those whose `text` contains `q` (case-insensitive,
/// substring — `instr(lower(text), lower(?))`, never `LIKE`: a virtual
/// path/comment/command may legally contain `%`/`_`, which `LIKE` would
/// otherwise treat as wildcards — same reasoning as `virtual_fs.rs`).
/// `total` is the full count of matching rows regardless of `limit`;
/// `truncated` is `total > limit`. A deck that has never had
/// `append_entries` called on it (the table itself does not exist) answers
/// `(vec![], 0, false)` rather than creating the table or erroring — a read
/// must never be the thing that first mutates the deck.
pub fn query(
    id: &str,
    limit: usize,
    q: Option<&str>,
) -> SlidraResult<(Vec<ChatEntry>, usize, bool)> {
    let conn = open(id)?;
    if !table_exists(&conn)? {
        return Ok((Vec::new(), 0, false));
    }

    let total: i64 = match q {
        None => conn
            .query_row("SELECT COUNT(*) FROM chat_history", [], |row| row.get(0))
            .map_err(io_err)?,
        Some(needle) => conn
            .query_row(
                "SELECT COUNT(*) FROM chat_history WHERE instr(lower(text), lower(?1)) > 0",
                params![needle],
                |row| row.get(0),
            )
            .map_err(io_err)?,
    };

    let limit_i64 = limit as i64;
    let mut rows_desc = Vec::new();
    match q {
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT seq, entry_id, kind, at, text, meta FROM chat_history
                     ORDER BY seq DESC LIMIT ?1",
                )
                .map_err(io_err)?;
            let mapped = stmt
                .query_map(params![limit_i64], row_to_entry)
                .map_err(io_err)?;
            for row in mapped {
                rows_desc.push(row.map_err(io_err)?);
            }
        }
        Some(needle) => {
            let mut stmt = conn
                .prepare(
                    "SELECT seq, entry_id, kind, at, text, meta FROM chat_history
                     WHERE instr(lower(text), lower(?1)) > 0
                     ORDER BY seq DESC LIMIT ?2",
                )
                .map_err(io_err)?;
            let mapped = stmt
                .query_map(params![needle, limit_i64], row_to_entry)
                .map_err(io_err)?;
            for row in mapped {
                rows_desc.push(row.map_err(io_err)?);
            }
        }
    }
    rows_desc.reverse();

    let total = total as usize;
    let truncated = total > limit;
    Ok((rows_desc, total, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_deck(label: &str) -> std::path::PathBuf {
        crate::deck::build_test_deck(label, &[])
    }

    fn entry(entry_id: &str, kind: &str, text: &str) -> ChatEntry {
        ChatEntry {
            seq: 0,
            entry_id: entry_id.to_string(),
            kind: kind.to_string(),
            at: "2024-01-01T00:00:00.000Z".to_string(),
            text: text.to_string(),
            meta: None,
        }
    }

    fn register(home: &std::path::Path, id: &str, deck: &std::path::Path) {
        crate::workspace::registry::register_for_test(home, id, deck);
    }

    struct Fixture {
        home: std::path::PathBuf,
        id: String,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let guard = crate::workspace::registry::ENV_LOCK.lock().unwrap();
            let home = std::env::temp_dir().join(format!(
                "slidra-test-chat-history-{label}-{}",
                crate::id::random_hex_suffix()
            ));
            let deck = temp_deck(label);
            let id = format!("pid-chat-{label}");
            register(&home, &id, &deck);
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            Fixture {
                home,
                id,
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
        }
    }

    #[test]
    fn query_on_a_deck_with_no_history_table_returns_empty_without_creating_it() {
        let fixture = Fixture::new("empty");
        let (entries, total, truncated) = query(&fixture.id, 20, None).unwrap();
        assert!(entries.is_empty());
        assert_eq!(total, 0);
        assert!(!truncated);
    }

    #[test]
    fn appending_the_same_entry_id_again_updates_in_place_and_keeps_seq_order() {
        let fixture = Fixture::new("upsert");
        append_entries(&fixture.id, &[entry("e1", "command", "slidra text set")]).unwrap();
        append_entries(&fixture.id, &[entry("e2", "agent", "done")]).unwrap();
        append_entries(
            &fixture.id,
            &[entry("e1", "command", "slidra text set (updated)")],
        )
        .unwrap();

        let (entries, total, _) = query(&fixture.id, 20, None).unwrap();
        assert_eq!(total, 2, "the second write to e1 must not add a new row");
        assert_eq!(entries[0].entry_id, "e1");
        assert_eq!(entries[0].text, "slidra text set (updated)");
        assert_eq!(entries[1].entry_id, "e2");
    }

    #[test]
    fn limit_truncates_to_the_most_recent_entries_and_reports_the_real_total() {
        let fixture = Fixture::new("limit");
        let entries: Vec<ChatEntry> = (0..5)
            .map(|n| entry(&format!("e{n}"), "author", &format!("msg {n}")))
            .collect();
        append_entries(&fixture.id, &entries).unwrap();

        let (page, total, truncated) = query(&fixture.id, 2, None).unwrap();
        assert_eq!(total, 5);
        assert!(truncated);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].entry_id, "e3");
        assert_eq!(page[1].entry_id, "e4");
    }

    #[test]
    fn query_filters_by_case_insensitive_substring_and_never_treats_percent_as_a_wildcard() {
        let fixture = Fixture::new("query");
        append_entries(
            &fixture.id,
            &[
                entry("e1", "author", "please update the Q3 revenue slide"),
                entry("e2", "agent", "done, updated the chart"),
                entry("e3", "author", "discount is 10%_off"),
            ],
        )
        .unwrap();

        let (hits, total, truncated) = query(&fixture.id, 20, Some("q3")).unwrap();
        assert_eq!(total, 1);
        assert!(!truncated);
        assert_eq!(hits[0].entry_id, "e1");

        // `%`/`_` in the needle must be taken literally, not as SQL LIKE
        // wildcards — a query for the literal substring "%_" must not match
        // "please" or "done" just because LIKE's wildcards would.
        let (literal_hits, literal_total, _) = query(&fixture.id, 20, Some("%_off")).unwrap();
        assert_eq!(literal_total, 1);
        assert_eq!(literal_hits[0].entry_id, "e3");

        let (no_hits, no_total, _) = query(&fixture.id, 20, Some("nonexistent")).unwrap();
        assert!(no_hits.is_empty());
        assert_eq!(no_total, 0);
    }

    #[test]
    fn copying_the_deck_file_carries_the_history_with_it() {
        let fixture = Fixture::new("copy");
        append_entries(
            &fixture.id,
            &[entry("e1", "author", "hello from the original")],
        )
        .unwrap();

        let original_path = crate::workspace::resolve_work_dir(&fixture.id).unwrap();
        let copied_path = std::env::temp_dir().join(format!(
            "slidra-test-chat-history-copy-target-{}.slidra",
            crate::id::random_hex_suffix()
        ));
        std::fs::copy(&original_path, &copied_path).unwrap();

        let copied_id = format!("{}-copy", fixture.id);
        register(&fixture.home, &copied_id, &copied_path);

        let (entries, total, _) = query(&copied_id, 20, None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(entries[0].text, "hello from the original");

        std::fs::remove_file(&copied_path).ok();
    }
}
