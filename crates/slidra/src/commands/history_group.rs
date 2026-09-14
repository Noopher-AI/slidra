// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra history begin-group <presentation-id>` / `history end-group
//! <presentation-id>` — [E6.T6] D4: internal-only commands, never exposed
//! via `docs/spec/cli.md`'s `` ## `name` `` heading format (see that
//! document's own "## Internal commands" section). The sole caller is
//! `packages/server`'s own turn grouping (`agent/session.ts`), which used
//! to read/write `stack.json`'s `openGroup` field directly and now calls
//! these two commands instead. Thin wrappers over
//! `history::begin_history_group`/`history::end_history_group`.

use crate::history;
use crate::result::{CommandResult, FailureKind};

pub fn dispatch(tokens: super::CommandTokens, args: &[String]) -> CommandResult {
    match tokens[1] {
        "begin-group" => begin_group(args),
        "end-group" => end_group(args),
        _ => unreachable!("resolve_takeover only ever returns entries from this table"),
    }
}

fn begin_group(args: &[String]) -> CommandResult {
    let Some(id) = args.first() else {
        return CommandResult::failure(
            "command history begin-group missing argument: presentation-id",
            FailureKind::Failed,
        );
    };
    match history::begin_history_group(id) {
        Ok(opened) => {
            let message = if opened {
                "opened a new undo group"
            } else {
                "joined an already-open undo group"
            };
            CommandResult::success(message, Some(serde_json::json!({ "opened": opened })))
        }
        Err(err) => CommandResult::from_error(&err),
    }
}

fn end_group(args: &[String]) -> CommandResult {
    let Some(id) = args.first() else {
        return CommandResult::failure(
            "command history end-group missing argument: presentation-id",
            FailureKind::Failed,
        );
    };
    match history::end_history_group(id) {
        Ok(()) => CommandResult::success("closed the undo group", None),
        Err(err) => CommandResult::from_error(&err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_group_missing_id_argument_fails_without_falling_back_to_node() {
        let result = begin_group(&[]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command history begin-group missing argument: presentation-id"
        );
    }

    #[test]
    fn end_group_missing_id_argument_fails_without_falling_back_to_node() {
        let result = end_group(&[]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command history end-group missing argument: presentation-id"
        );
    }

    #[test]
    fn begin_group_unknown_id_is_not_found() {
        let result = begin_group(&["definitely-not-a-real-id-in-any-test-fixture".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }

    #[test]
    fn end_group_unknown_id_is_not_found() {
        let result = end_group(&["definitely-not-a-real-id-in-any-test-fixture".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }
}
