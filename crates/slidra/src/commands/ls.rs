// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra ls <presentation-id> [path]`.

use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::{argv, workspace};

pub fn run(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "ls", "id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let virtual_path = args.get(1).cloned().unwrap_or_default();

    let work_dir = match workspace::resolve_work_dir(&id) {
        Ok(w) => w,
        Err(err) => {
            return CommandResult::failure(err.message().to_string(), failure_kind_for(&err));
        }
    };
    match workspace::virtual_fs::list_virtual_entries(&work_dir, &virtual_path) {
        Ok(entries) => {
            let message = format!("{} items total", entries.len());
            CommandResult::success(message, Some(serde_json::json!({ "entries": entries })))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// Mimics the Unix tool: one entry name per line, nothing else — no count,
/// no summary, no JSON.
pub fn render(data: &serde_json::Value) -> Vec<u8> {
    let entries = data.get("entries").and_then(|v| v.as_array());
    let mut out = String::new();
    if let Some(entries) = entries {
        for entry in entries {
            if let Some(s) = entry.as_str() {
                out.push_str(s);
                out.push('\n');
            }
        }
    }
    out.into_bytes()
}

fn failure_kind_for(err: &SlidraError) -> FailureKind {
    match err {
        SlidraError::NotFound(_) => FailureKind::NotFound,
        SlidraError::InvalidRequest(_) => FailureKind::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_id_argument_fails() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "command ls missing argument: id");
    }

    #[test]
    fn unknown_id_is_not_found() {
        let result = run(&["definitely-not-a-real-id".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }

    #[test]
    fn render_joins_entries_with_trailing_newlines() {
        let data = serde_json::json!({ "entries": ["a.svg", "b.svg"] });
        assert_eq!(render(&data), b"a.svg\nb.svg\n");
    }

    #[test]
    fn render_of_empty_entries_is_empty() {
        let data = serde_json::json!({ "entries": [] });
        assert_eq!(render(&data), b"");
    }
}
