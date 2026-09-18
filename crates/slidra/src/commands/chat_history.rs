// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra chat-history <presentation-id> [--limit <n>] [--query <text>]`
//! and `slidra chat-history <presentation-id> --append -` (write, JSON array
//! on stdin — `main.rs`'s `maybe_read_stdin_chat_history` substitutes it in
//! at the entry layer, the same way `--csv -` does for `chart data set`;
//! see that function's own doc for why stdin can only be read there).
//! Legacy (single-token) takeover-table command, not a family — plain
//! `commands::mod`'s doc comment, "everything else" bucket.
//!
//! Additive to the SQLite container format (ADR: `spec/rfcs/0001-sqlite-
//! container-format.md`) without bumping `FORMAT_VERSION` or touching
//! `deck.rs`'s `SCHEMA_SQL`: `chat_history.rs`'s own `CREATE TABLE IF NOT
//! EXISTS` is what actually creates the table, lazily, on the first write —
//! this keeps every other wave-2 ticket that also wants a new table from
//! colliding with this one on a shared schema/migration edit.

use crate::chat_history::{self, ChatEntry};
use crate::commands::argv;
use crate::errors::SlidraError;
use crate::result::CommandResult;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 1000;

pub fn run(args: &[String], stdin_body: Option<String>) -> CommandResult {
    try_run(args, stdin_body).unwrap_or_else(|err| CommandResult::from_error(&err))
}

fn try_run(args: &[String], stdin_body: Option<String>) -> crate::errors::SlidraResult<CommandResult> {
    let id = argv::require_id_positional(args, 0, "chat-history", "presentation-id")?.to_string();

    if let Some(marker) = argv::optional_flag(args, "--append")? {
        if marker != "-" {
            return Err(SlidraError::invalid("--append only accepts - (read the batch from stdin)"));
        }
        return append(&id, stdin_body);
    }

    let limit = match argv::optional_flag(args, "--limit")? {
        Some(raw) => parse_limit(raw)?,
        None => DEFAULT_LIMIT as usize,
    };
    let query = match argv::optional_flag(args, "--query")? {
        Some(raw) if raw.is_empty() => {
            return Err(SlidraError::invalid("--query must not be empty"));
        }
        Some(raw) => Some(raw.to_string()),
        None => None,
    };

    let (entries, total, truncated) = chat_history::query(&id, limit, query.as_deref())?;
    let message = format!("{} chat entries", entries.len());
    let data = serde_json::json!({
        "entries": entries.iter().map(entry_json).collect::<Vec<_>>(),
        "total": total,
        "truncated": truncated,
    });
    Ok(CommandResult::success(message, Some(data)))
}

fn parse_limit(raw: &str) -> crate::errors::SlidraResult<usize> {
    match raw.parse::<i64>() {
        Ok(n) if (1..=MAX_LIMIT).contains(&n) => Ok(n as usize),
        _ => Err(SlidraError::invalid(format!(
            "--limit must be an integer between 1 and {MAX_LIMIT}"
        ))),
    }
}

/// Parses stdin as a JSON array of chat entries and writes them in one
/// batch. Malformed input (not JSON, not an array, an entry missing a
/// required field or carrying an out-of-range `kind`) fails the whole batch
/// before `chat_history::append_entries` ever opens a transaction — partial
/// writes from a malformed batch would leave the deck's history
/// inconsistent with whatever the caller thinks it sent.
fn append(id: &str, stdin_body: Option<String>) -> crate::errors::SlidraResult<CommandResult> {
    let body = stdin_body.ok_or_else(|| SlidraError::invalid("--append - requires a JSON array on stdin"))?;
    let raw: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| SlidraError::invalid("stdin must be a JSON array of chat entries"))?;
    let raw_entries = raw
        .as_array()
        .ok_or_else(|| SlidraError::invalid("stdin must be a JSON array of chat entries"))?;

    let mut entries = Vec::with_capacity(raw_entries.len());
    for raw_entry in raw_entries {
        entries.push(parse_entry(raw_entry)?);
    }

    let count = chat_history::append_entries(id, &entries)?;
    Ok(CommandResult::success(
        format!("appended {count} chat entries"),
        Some(serde_json::json!({ "appended": count })),
    ))
}

fn parse_entry(raw: &serde_json::Value) -> crate::errors::SlidraResult<ChatEntry> {
    let obj = raw
        .as_object()
        .ok_or_else(|| SlidraError::invalid("chat entry must be a JSON object"))?;
    let entry_id = obj
        .get("entryId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SlidraError::invalid("chat entry missing entryId"))?
        .to_string();
    let kind = obj
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SlidraError::invalid("chat entry missing kind"))?
        .to_string();
    if !chat_history::VALID_KINDS.contains(&kind.as_str()) {
        return Err(SlidraError::invalid(format!("invalid chat entry kind: {kind}")));
    }
    let at = obj
        .get("at")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SlidraError::invalid("chat entry missing at"))?
        .to_string();
    let text = obj
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SlidraError::invalid("chat entry missing text"))?
        .to_string();
    let meta = obj.get("meta").cloned().filter(|v| !v.is_null());

    Ok(ChatEntry {
        seq: 0,
        entry_id,
        kind,
        at,
        text,
        meta,
    })
}

/// Flattens `entry.meta`'s fields (a `command` entry's `toolCallId`/
/// `status`/`cli`/`output`/`blocked`) up into the entry's own JSON object,
/// alongside `entryId`/`seq`/`kind`/`at`/`text` — the CLI's JSON envelope
/// shape, one flat object per entry, not a nested `meta` field a caller
/// would have to know to look inside.
fn entry_json(entry: &ChatEntry) -> serde_json::Value {
    let mut value = serde_json::json!({
        "entryId": entry.entry_id,
        "seq": entry.seq,
        "kind": entry.kind,
        "at": entry.at,
        "text": entry.text,
    });
    if let Some(meta_obj) = entry.meta.as_ref().and_then(|meta| meta.as_object()) {
        let target = value.as_object_mut().expect("value is always built as an object above");
        for (key, val) in meta_obj {
            target.insert(key.clone(), val.clone());
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        home: std::path::PathBuf,
        id: String,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let guard = crate::workbench::runtime::ENV_LOCK.lock().unwrap();
            let home = std::env::temp_dir().join(format!(
                "slidra-test-cmd-chat-history-{label}-{}",
                crate::id::random_hex_suffix()
            ));
            let deck = crate::deck::build_test_deck(label, &[]);
            let id = format!("pid-cmd-chat-{label}");
            crate::workbench::runtime::register_for_test(&home, &id, &deck);
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
    fn query_on_an_empty_deck_succeeds_with_no_entries() {
        let fixture = Fixture::new("empty");
        let result = run(&[fixture.id.clone()], None);
        assert!(result.ok, "{}", result.message);
        let data = result.data.unwrap();
        assert_eq!(data["entries"].as_array().unwrap().len(), 0);
        assert_eq!(data["total"], 0);
        assert_eq!(data["truncated"], false);
    }

    #[test]
    fn limit_rejects_non_integer_zero_negative_and_over_the_cap() {
        let fixture = Fixture::new("limit-bounds");
        for bad in ["0", "-1", "1001", "abc", "3.5"] {
            let result = run(
                &[fixture.id.clone(), "--limit".to_string(), bad.to_string()],
                None,
            );
            assert!(!result.ok, "expected --limit {bad} to fail");
            assert_eq!(result.message, "--limit must be an integer between 1 and 1000");
        }
    }

    #[test]
    fn empty_query_is_rejected_rather_than_returning_everything() {
        let fixture = Fixture::new("empty-query");
        let result = run(
            &[fixture.id.clone(), "--query".to_string(), "".to_string()],
            None,
        );
        assert!(!result.ok);
        assert_eq!(result.message, "--query must not be empty");
    }

    #[test]
    fn append_writes_a_batch_and_query_reads_it_back_in_order() {
        let fixture = Fixture::new("append");
        let stdin = serde_json::json!([
            { "entryId": "e1", "kind": "author", "at": "2024-01-01T00:00:00.000Z", "text": "hello" },
            {
                "entryId": "e2", "kind": "command", "at": "2024-01-01T00:00:01.000Z",
                "text": "slidra text set pid slides/001.svg el-1 hi",
                "meta": { "toolCallId": "tc-1", "status": "completed", "cli": true }
            },
        ]);
        let append_result = run(
            &[fixture.id.clone(), "--append".to_string(), "-".to_string()],
            Some(stdin.to_string()),
        );
        assert!(append_result.ok, "{}", append_result.message);
        assert_eq!(append_result.data.unwrap()["appended"], 2);

        let read = run(&[fixture.id.clone()], None);
        assert!(read.ok, "{}", read.message);
        let data = read.data.unwrap();
        assert_eq!(data["total"], 2);
        let entries = data["entries"].as_array().unwrap();
        assert_eq!(entries[0]["entryId"], "e1");
        assert_eq!(entries[1]["entryId"], "e2");
        assert_eq!(entries[1]["toolCallId"], "tc-1");
        assert_eq!(entries[1]["status"], "completed");
        assert_eq!(entries[1]["cli"], true);
    }

    #[test]
    fn append_with_no_stdin_fails() {
        let fixture = Fixture::new("no-stdin");
        let result = run(
            &[fixture.id.clone(), "--append".to_string(), "-".to_string()],
            None,
        );
        assert!(!result.ok);
        assert_eq!(result.message, "--append - requires a JSON array on stdin");
    }

    #[test]
    fn append_rejects_malformed_json_missing_fields_and_bad_kind_writing_nothing() {
        let fixture = Fixture::new("malformed");

        let not_json = run(
            &[fixture.id.clone(), "--append".to_string(), "-".to_string()],
            Some("not json".to_string()),
        );
        assert!(!not_json.ok);

        let missing_entry_id = run(
            &[fixture.id.clone(), "--append".to_string(), "-".to_string()],
            Some(r#"[{"kind":"author","at":"2024-01-01T00:00:00.000Z","text":"hi"}]"#.to_string()),
        );
        assert!(!missing_entry_id.ok);
        assert_eq!(missing_entry_id.message, "chat entry missing entryId");

        let bad_kind = run(
            &[fixture.id.clone(), "--append".to_string(), "-".to_string()],
            Some(r#"[{"entryId":"e1","kind":"notice","at":"2024-01-01T00:00:00.000Z","text":"hi"}]"#.to_string()),
        );
        assert!(!bad_kind.ok);
        assert_eq!(bad_kind.message, "invalid chat entry kind: notice");

        // A batch of two where only the SECOND entry is invalid must still
        // write neither — all-or-nothing.
        let partially_bad = run(
            &[fixture.id.clone(), "--append".to_string(), "-".to_string()],
            Some(
                r#"[{"entryId":"ok","kind":"author","at":"2024-01-01T00:00:00.000Z","text":"hi"},
                    {"kind":"agent","at":"2024-01-01T00:00:00.000Z","text":"oops"}]"#
                    .to_string(),
            ),
        );
        assert!(!partially_bad.ok);

        let read = run(&[fixture.id.clone()], None);
        assert_eq!(read.data.unwrap()["total"], 0, "no partial writes from a rejected batch");
    }

    #[test]
    fn unknown_presentation_id_is_not_found() {
        let result = run(&["definitely-not-a-real-id".to_string()], None);
        assert!(!result.ok);
        assert_eq!(
            result.failure_kind,
            Some(crate::result::FailureKind::NotFound)
        );
    }
}
