//! `comotion undo <presentation-id> [extra...]`. Ported to Rust as one of
//! this ticket's two takeover-table commands (the other is `redo.rs`, which
//! is this file's near-mirror).

use crate::errors::CoMotionError;
use crate::history;
use crate::result::{CommandResult, FailureKind};

/// `args` is whatever positional arguments followed `undo` on the command
/// line, already stripped of the Rust-only `--json` flag by main.rs.
///
/// Extra positional arguments beyond the id are silently ignored — this is
/// a confirmed, deliberate TS behaviour (`comotion undo <id> extra`
/// succeeds normally; verified against the running Node CLI), not an
/// oversight to "fix". `main.rs`'s dispatch must never route this command
/// through a parser (e.g. clap's default positional-arity checking) that
/// would reject the extra argument instead.
pub fn run(args: &[String]) -> CommandResult {
    let Some(id) = args.first() else {
        return CommandResult::failure("命令 undo 缺少參數：presentation-id", FailureKind::Failed);
    };

    match history::undo(id) {
        Ok(result) => {
            let data = serde_json::json!({ "restoredPaths": result.restored_paths });
            CommandResult::success("已復原上一步操作", Some(data))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// `NotFound` (unknown presentation id) is the only case the HTTP layer
/// (`serve`, out of this ticket's scope) needs to distinguish from a
/// generic failure — everything else, including "nothing to undo", is
/// `Failed`. `result::render`'s non-`--json` path doesn't print this value
/// at all (see result.rs); it only matters for `--json` output and for a
/// future `serve` HTTP status mapping.
fn failure_kind_for(err: &CoMotionError) -> FailureKind {
    match err {
        CoMotionError::NotFound(_) => FailureKind::NotFound,
        CoMotionError::InvalidRequest(_) => FailureKind::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_id_argument_fails_without_falling_back_to_node() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 undo 缺少參數：presentation-id");
    }

    #[test]
    fn unknown_id_is_not_found() {
        // No COMOTION_HOME fixture is set up here; resolve_work_dir will
        // fail to find this id under whatever COMOTION_HOME happens to
        // resolve to in the test process, which is exactly the "unknown id"
        // path this test wants to exercise.
        let result = run(&["definitely-not-a-real-id-in-any-test-fixture".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }
}
