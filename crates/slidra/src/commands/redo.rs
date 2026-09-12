//! `slidra redo <presentation-id> [extra...]` — mirrors `undo.rs`; see
//! its doc comments for the shared rationale (extra positional args ignored,
//! `--json` already stripped by main.rs, `FailureKind` mapping).

use crate::errors::SlidraError;
use crate::history;
use crate::result::{CommandResult, FailureKind};

pub fn run(args: &[String]) -> CommandResult {
    let Some(id) = args.first() else {
        return CommandResult::failure("命令 redo 缺少參數：presentation-id", FailureKind::Failed);
    };

    match history::redo(id) {
        Ok(result) => {
            let data = serde_json::json!({ "restoredPaths": result.restored_paths });
            CommandResult::success("已重做上一步操作", Some(data))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
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
    fn missing_id_argument_fails_without_falling_back_to_node() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 redo 缺少參數：presentation-id");
    }

    #[test]
    fn unknown_id_is_not_found() {
        let result = run(&["definitely-not-a-real-id-in-any-test-fixture".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }
}
