// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `deck *` family: `deck list` / `deck meta set` ([E6.T2], NOOP-448 plan
//! §7 decision 6) — CLI argv layer for scanning a folder of `.slidra` files
//! that have never been `open`ed (no registry entry, no presentation id
//! yet) and for setting a deck's `project.json` `name`/`owner` fields
//! directly by file path.
//!
//! Unlike every other family under the newer takeover mechanism
//! (`element`/`text`/`textbox`/`comment`), both commands here take a real
//! filesystem path as their first positional, not a `<presentation-id>` —
//! the same reason `new`/`open` do: the folder `deck list` scans has not
//! been opened yet, so there is no id to resolve through the registry
//! (ADR-0002/0019: `packages/server`'s TS side never reads `.slidra` bytes
//! itself, so this scan has to be a Rust subprocess call).
//!
//! `deck list`'s per-entry failure handling deliberately mirrors
//! `commands::open`'s own tolerance: a legacy ZIP or corrupted file in the
//! scanned folder yields one null entry, never a whole-command failure —
//! only `open` migrates a legacy ZIP, so a bare listing must not.

use crate::commands::CommandTokens;
use crate::commands::argv::{optional_flag, require_positional};
use crate::errors::{SlidraError, SlidraResult};
use crate::result::CommandResult;
use crate::workspace::project::{self, ProjectJson};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const TAKEOVER: &[CommandTokens] = &[&["deck", "list"], &["deck", "meta", "set"]];

pub fn dispatch(tokens: CommandTokens, args: &[String]) -> CommandResult {
    match &tokens[1..] {
        ["list"] => list::run(args),
        ["meta", "set"] => meta_set::run(args),
        _ => unreachable!("commands::deck::TAKEOVER only lists entries dispatch handles"),
    }
}

mod list {
    use super::*;

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        let path = require_positional(args, 0, "deck list", "path")?;
        let owner_filter = optional_flag(args, "--owner")?;

        let entries = list_decks(Path::new(path), owner_filter)?;
        let count = entries.len();
        Ok(CommandResult::success(
            format!("{count} deck(s) found"),
            Some(serde_json::json!({ "decks": entries })),
        ))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }

    fn has_slidra_extension(path: &Path) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("slidra"))
    }

    /// The `.slidra` files to describe: `root` itself when it is a file,
    /// every direct (non-recursive) `.slidra` entry when it is a
    /// directory — sorted for a deterministic result. `NotFound` when
    /// `root` does not exist at all, mirroring `ls`'s own "unresolvable
    /// directory" contract.
    fn candidate_paths(root: &Path) -> SlidraResult<Vec<PathBuf>> {
        let metadata = std::fs::metadata(root)
            .map_err(|_| SlidraError::not_found(format!("directory not found: {}", root.display())))?;
        if metadata.is_file() {
            return Ok(vec![root.to_path_buf()]);
        }
        let entries = std::fs::read_dir(root)
            .map_err(|_| SlidraError::not_found(format!("directory not found: {}", root.display())))?;
        let mut paths = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else { continue };
            let entry_path = entry.path();
            if !has_slidra_extension(&entry_path) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            paths.push(entry_path);
        }
        paths.sort();
        Ok(paths)
    }

    fn read_owner(project: &ProjectJson) -> Value {
        match project.raw.get("owner") {
            Some(Value::String(s)) => Value::String(s.clone()),
            _ => Value::Null,
        }
    }

    /// Describes one candidate `.slidra` file. Never propagates a per-file
    /// read/parse failure (an unmigrated legacy ZIP, a corrupted container)
    /// out of the whole listing — that failure becomes a null-valued entry
    /// instead, per plan §4's behavior table ("資料夾內有壞檔／legacy ZIP →
    /// 該筆回 null，列表不得整體失敗").
    fn describe_deck(path: &Path) -> Value {
        let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match project::read_project_json(path) {
            Ok(project) => serde_json::json!({
                "fileName": file_name,
                "name": project.name,
                "slideCount": project.slides.len(),
                "owner": read_owner(&project),
            }),
            Err(_) => serde_json::json!({
                "fileName": file_name,
                "name": Value::Null,
                "slideCount": Value::Null,
                "owner": Value::Null,
            }),
        }
    }

    fn list_decks(root: &Path, owner_filter: Option<&str>) -> SlidraResult<Vec<Value>> {
        let paths = candidate_paths(root)?;
        let mut entries: Vec<Value> = paths.iter().map(|p| describe_deck(p)).collect();
        if let Some(owner) = owner_filter {
            entries.retain(|entry| entry.get("owner").and_then(Value::as_str) == Some(owner));
        }
        Ok(entries)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::result::FailureKind;
        use std::collections::BTreeMap;

        fn temp_dir(label: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("slidra-test-deck-list-{label}-{}", crate::id::random_hex_suffix()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn write_deck(dir: &Path, file_name: &str, name: &str, slides: usize, owner: Option<&str>) -> PathBuf {
            let path = dir.join(file_name);
            let mut files: BTreeMap<String, Vec<u8>> =
                crate::presentation::build_minimal_presentation(name).into_iter().collect();
            for i in 0..slides {
                files.insert(
                    format!("slides/{i:03}.svg"),
                    b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>\n".to_vec(),
                );
            }
            crate::deck::create_new_with_files(&path, &files).unwrap();
            let mut raw = project::read_project_json(&path).unwrap().raw;
            raw.insert("name".to_string(), Value::String(name.to_string()));
            raw.insert(
                "slides".to_string(),
                Value::Array((0..slides).map(|i| Value::String(format!("slides/{i:03}.svg"))).collect()),
            );
            if let Some(owner) = owner {
                raw.insert("owner".to_string(), Value::String(owner.to_string()));
            }
            let content = project::serialize_project_json(&raw);
            crate::workspace::virtual_fs::force_write_file(&path, "project.json", content.as_bytes()).unwrap();
            path
        }

        #[test]
        fn lists_every_slidra_file_in_a_directory() {
            let dir = temp_dir("normal");
            write_deck(&dir, "a.slidra", "Deck A", 2, None);
            write_deck(&dir, "b.slidra", "Deck B", 0, None);
            std::fs::write(dir.join("ignored.txt"), b"not a deck").unwrap();

            let result = run(&[dir.to_string_lossy().into_owned()]);
            assert!(result.ok, "expected success, got {}", result.message);
            let decks = result.data.as_ref().unwrap()["decks"].as_array().unwrap();
            assert_eq!(decks.len(), 2);
            let names: Vec<&str> = decks.iter().map(|d| d["name"].as_str().unwrap()).collect();
            assert_eq!(names, vec!["Deck A", "Deck B"]);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn empty_directory_lists_as_empty_not_an_error() {
            let dir = temp_dir("empty");
            let result = run(&[dir.to_string_lossy().into_owned()]);
            assert!(result.ok);
            assert_eq!(result.data.as_ref().unwrap()["decks"].as_array().unwrap().len(), 0);
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn nonexistent_directory_is_not_found() {
            let dir = temp_dir("missing").join("does-not-exist");
            let result = run(&[dir.to_string_lossy().into_owned()]);
            assert!(!result.ok);
            assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
        }

        #[test]
        fn a_corrupt_file_becomes_a_null_entry_without_failing_the_whole_list() {
            let dir = temp_dir("corrupt");
            write_deck(&dir, "good.slidra", "Good Deck", 1, None);
            std::fs::write(dir.join("bad.slidra"), b"not a real deck file at all").unwrap();

            let result = run(&[dir.to_string_lossy().into_owned()]);
            assert!(result.ok, "expected success, got {}", result.message);
            let decks = result.data.as_ref().unwrap()["decks"].as_array().unwrap();
            assert_eq!(decks.len(), 2);
            let bad = decks.iter().find(|d| d["fileName"] == "bad.slidra").unwrap();
            assert_eq!(bad["name"], Value::Null);
            assert_eq!(bad["slideCount"], Value::Null);
            assert_eq!(bad["owner"], Value::Null);
            let good = decks.iter().find(|d| d["fileName"] == "good.slidra").unwrap();
            assert_eq!(good["name"], Value::String("Good Deck".to_string()));

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn owner_flag_filters_to_an_exact_match() {
            let dir = temp_dir("owner-filter");
            write_deck(&dir, "mine.slidra", "Mine", 0, Some("alice"));
            write_deck(&dir, "theirs.slidra", "Theirs", 0, Some("bob"));
            write_deck(&dir, "unowned.slidra", "Unowned", 0, None);

            let result = run(&[dir.to_string_lossy().into_owned(), "--owner".to_string(), "alice".to_string()]);
            assert!(result.ok);
            let decks = result.data.as_ref().unwrap()["decks"].as_array().unwrap();
            assert_eq!(decks.len(), 1);
            assert_eq!(decks[0]["fileName"], "mine.slidra");

            std::fs::remove_dir_all(&dir).ok();
        }
    }
}

mod meta_set {
    use super::*;
    use crate::workspace::virtual_fs;

    fn try_run(args: &[String]) -> SlidraResult<CommandResult> {
        const COMMAND: &str = "deck meta set";
        let path = require_positional(args, 0, COMMAND, "deck-path")?.to_string();
        let name = optional_flag(args, "--name")?.map(str::to_string);
        let owner = optional_flag(args, "--owner")?.map(str::to_string);
        if name.is_none() && owner.is_none() {
            return Err(SlidraError::invalid(format!(
                "command {COMMAND} requires --name or --owner"
            )));
        }

        set_meta(Path::new(&path), name.as_deref(), owner.as_deref())?;
        Ok(CommandResult::success("deck metadata updated".to_string(), Some(serde_json::json!({}))))
    }

    pub fn run(args: &[String]) -> CommandResult {
        try_run(args).unwrap_or_else(|err| CommandResult::from_error(&err))
    }

    /// Sets `name`/`owner` directly on `path`'s `project.json`, without
    /// going through `write::write_presentation_file` (no undo history, no
    /// registry lookup) — this runs on decks that may not be registered at
    /// all yet (a brand-new `slidra new` output, or a deck `deck list` just
    /// found sitting in a folder), the same reason `new`/`open` operate on
    /// a bare path rather than a `<presentation-id>`.
    fn set_meta(path: &Path, name: Option<&str>, owner: Option<&str>) -> SlidraResult<()> {
        let project = project::read_project_json(path)?;
        let mut raw = project.raw;
        if let Some(name) = name {
            raw.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(owner) = owner {
            raw.insert("owner".to_string(), Value::String(owner.to_string()));
        }
        let content = project::serialize_project_json(&raw);
        virtual_fs::force_write_file(path, "project.json", content.as_bytes())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp_deck(label: &str) -> PathBuf {
            let path = std::env::temp_dir().join(format!("slidra-test-deck-meta-{label}-{}.slidra", crate::id::random_hex_suffix()));
            let files: std::collections::BTreeMap<String, Vec<u8>> =
                crate::presentation::build_minimal_presentation("Original Name").into_iter().collect();
            crate::deck::create_new_with_files(&path, &files).unwrap();
            path
        }

        #[test]
        fn missing_both_flags_fails() {
            let path = temp_deck("missing-flags");
            let result = run(&[path.to_string_lossy().into_owned()]);
            assert!(!result.ok);
            assert_eq!(result.message, "command deck meta set requires --name or --owner");
            std::fs::remove_file(&path).ok();
        }

        #[test]
        fn sets_owner_and_reads_it_back_leaving_other_fields_untouched() {
            let path = temp_deck("owner-roundtrip");
            let before = project::read_project_json(&path).unwrap();

            let result = run(&[path.to_string_lossy().into_owned(), "--owner".to_string(), "alice".to_string()]);
            assert!(result.ok, "expected success, got {}", result.message);

            let after = project::read_project_json(&path).unwrap();
            assert_eq!(after.raw.get("owner").and_then(Value::as_str), Some("alice"));
            assert_eq!(after.name, before.name);
            assert_eq!(after.slides, before.slides);
            assert_eq!(after.format_version, before.format_version);

            std::fs::remove_file(&path).ok();
        }
    }
}
