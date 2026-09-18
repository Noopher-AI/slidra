// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The list of deck paths a person has opened — `<SLIDRA_HOME>/decks.json`,
//! a JSON array of strings, most recently opened first. Nothing else is
//! stored in it (AC).
//!
//! Reading and recording are asymmetric on purpose (plan §7.6): reading
//! filters out entries whose file no longer exists, but never rewrites the
//! file to persist that filtering — the file on disk keeps the full raw
//! history until the next `record_opened_deck` write touches it. This is
//! deliberately not synchronized against a concurrent writer with a lock
//! file: two racing `record_opened_deck` calls may overwrite each other's
//! entry, a known and accepted tradeoff (the previous local layout's
//! per-file coordination is explicitly not carried forward here).

use crate::errors::{SlidraError, SlidraResult};
use crate::workspace::resolve_home;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn deck_list_path(home: &Path) -> PathBuf {
    home.join("decks.json")
}

fn parse_deck_list(raw: &str) -> SlidraResult<Vec<PathBuf>> {
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| SlidraError::invalid("deck list is corrupted"))?;
    let array = parsed
        .as_array()
        .ok_or_else(|| SlidraError::invalid("deck list is corrupted"))?;
    let mut paths = Vec::with_capacity(array.len());
    for entry in array {
        let path = entry
            .as_str()
            .ok_or_else(|| SlidraError::invalid("deck list is corrupted"))?;
        paths.push(PathBuf::from(path));
    }
    Ok(paths)
}

/// The raw, unfiltered list as currently persisted — a genuinely missing
/// file is an empty list (nothing has ever been recorded yet), same stance
/// as the presentation registry's own missing-file handling.
fn load_raw(home: &Path) -> SlidraResult<Vec<PathBuf>> {
    match std::fs::read_to_string(deck_list_path(home)) {
        Ok(text) => parse_deck_list(&text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(SlidraError::invalid("failed to read deck list")),
    }
}

/// Atomically writes the deck list: a private temp file, then `rename`d
/// over `decks.json` — untearable, though (deliberately, see this module's
/// doc comment) not locked against a concurrent writer.
fn write_deck_list(home: &Path, paths: &[PathBuf]) -> SlidraResult<()> {
    std::fs::create_dir_all(home).map_err(|_| SlidraError::invalid("failed to write deck list"))?;
    let array: Vec<Value> = paths
        .iter()
        .map(|path| Value::String(path.to_string_lossy().into_owned()))
        .collect();
    let mut json = serde_json::to_string_pretty(&Value::Array(array))
        .map_err(|_| SlidraError::invalid("failed to write deck list"))?;
    json.push('\n');

    let final_path = deck_list_path(home);
    let temp_path = home.join(format!(
        ".decks.json.{}.tmp",
        crate::id::random_hex_suffix()
    ));
    let write_result: std::io::Result<()> = (|| {
        std::fs::write(&temp_path, &json)?;
        std::fs::rename(&temp_path, &final_path)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
        return Err(SlidraError::invalid("failed to write deck list"));
    }
    Ok(())
}

/// Reads the deck list, silently dropping entries whose file no longer
/// exists (AC: "Reading it drops entries whose file no longer exists,
/// silently"). Never rewrites the file — see this module's doc comment.
pub fn read_deck_list() -> SlidraResult<Vec<PathBuf>> {
    let home = resolve_home();
    let raw = load_raw(&home)?;
    Ok(raw.into_iter().filter(|path| path.is_file()).collect())
}

/// Records `path` as the most recently opened deck: moves it to the front
/// if already present (no duplicate entries), with no cap on length.
/// Operates on the raw, unfiltered list — an entry for a currently
/// unreachable path is preserved rather than dropped by a side effect of
/// recording an unrelated deck (only `read_deck_list` filters).
pub fn record_opened_deck(path: &Path) -> SlidraResult<()> {
    let home = resolve_home();
    let mut paths = load_raw(&home)?;
    paths.retain(|existing| existing != path);
    paths.insert(0, path.to_path_buf());
    write_deck_list(&home, &paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::runtime::ENV_LOCK;

    struct Fixture {
        home: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let home = std::env::temp_dir().join(format!(
                "slidra-test-decklist-{label}-{}",
                crate::id::random_hex_suffix()
            ));
            std::fs::create_dir_all(&home).unwrap();
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            Fixture {
                home,
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
    fn missing_deck_list_file_reads_as_empty_not_error() {
        let fixture = Fixture::new("missing");
        assert_eq!(read_deck_list().unwrap(), Vec::<PathBuf>::new());
        drop(fixture);
    }

    #[test]
    fn record_opened_deck_then_read_deck_list_round_trips() {
        let fixture = Fixture::new("round-trip");
        let deck = fixture.home.join("present.slidra");
        std::fs::write(&deck, b"deck bytes").unwrap();

        record_opened_deck(&deck).unwrap();

        assert_eq!(read_deck_list().unwrap(), vec![deck.clone()]);
        std::fs::remove_file(&deck).ok();
        drop(fixture);
    }

    #[test]
    fn reading_after_a_listed_file_is_deleted_drops_that_entry_without_error_or_rewriting_file() {
        let fixture = Fixture::new("dangling");
        let kept = fixture.home.join("kept.slidra");
        let gone = fixture.home.join("gone.slidra");
        std::fs::write(&kept, b"x").unwrap();
        std::fs::write(&gone, b"x").unwrap();
        record_opened_deck(&gone).unwrap();
        record_opened_deck(&kept).unwrap();
        std::fs::remove_file(&gone).unwrap();

        let before_raw = std::fs::read_to_string(deck_list_path(&fixture.home)).unwrap();
        let entries = read_deck_list().unwrap();
        let after_raw = std::fs::read_to_string(deck_list_path(&fixture.home)).unwrap();

        assert_eq!(entries, vec![kept.clone()]);
        assert_eq!(
            before_raw, after_raw,
            "reading must not rewrite the underlying file"
        );
        std::fs::remove_file(&kept).ok();
        drop(fixture);
    }

    #[test]
    fn malformed_deck_list_json_or_non_string_element_is_invalid_request() {
        let fixture = Fixture::new("malformed");
        std::fs::write(deck_list_path(&fixture.home), "{not valid json").unwrap();
        let err = read_deck_list().unwrap_err();
        assert!(matches!(err, SlidraError::InvalidRequest(_)));

        std::fs::write(deck_list_path(&fixture.home), r#"["ok.slidra", 5]"#).unwrap();
        let err = read_deck_list().unwrap_err();
        assert!(matches!(err, SlidraError::InvalidRequest(_)));
        drop(fixture);
    }

    #[test]
    fn record_opened_deck_moves_an_existing_path_to_front_without_duplicating() {
        let fixture = Fixture::new("reorder");
        let a = fixture.home.join("a.slidra");
        let b = fixture.home.join("b.slidra");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(&b, b"x").unwrap();

        record_opened_deck(&a).unwrap();
        record_opened_deck(&b).unwrap();
        record_opened_deck(&a).unwrap();

        assert_eq!(read_deck_list().unwrap(), vec![a.clone(), b.clone()]);
        std::fs::remove_file(&a).ok();
        std::fs::remove_file(&b).ok();
        drop(fixture);
    }
}
