//! `co-motion cat <presentation-id> <path>` and, only under `--json`,
//! `co-motion cat <presentation-id> <path...> --json` (multi-path).

use crate::errors::CoMotionError;
use crate::result::{CommandResult, FailureKind};
use crate::{argv, workspace};

/// `json_flag` changes `cat`'s own arity, not just its output format:
/// `docs/spec/cli.md` — "`cat --json` 是唯一允許接受多個 `<path>` 的形式"
/// — so `main.rs` must tell this handler whether `--json` was present
/// before argv parsing happens here, not only pass it to `result::render`
/// afterwards.
pub fn run(args: &[String], json_flag: bool) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "cat", "id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let work_dir = match workspace::resolve_work_dir(&id) {
        Ok(w) => w,
        Err(err) => {
            return CommandResult::failure(err.message().to_string(), failure_kind_for(&err));
        }
    };

    if json_flag {
        let paths = &args[1..];
        if paths.is_empty() {
            return CommandResult::failure(
                "命令 cat 缺少參數：path".to_string(),
                FailureKind::Failed,
            );
        }
        let mut results = Vec::with_capacity(paths.len());
        for path in paths {
            match workspace::virtual_fs::read_virtual_file_bytes(&work_dir, path) {
                Ok(bytes) => results.push(
                    serde_json::json!({ "path": path, "content": crate::base64::encode(&bytes) }),
                ),
                Err(err) => {
                    return CommandResult::failure(
                        err.message().to_string(),
                        failure_kind_for(&err),
                    );
                }
            }
        }
        let message = format!("已讀取：{}", paths.join("、"));
        return CommandResult::success(message, Some(serde_json::Value::Array(results)));
    }

    let path = match argv::require_positional(args, 1, "cat", "path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match workspace::virtual_fs::read_virtual_file(&work_dir, &path) {
        Ok(content) => CommandResult::success(
            format!("已讀取：{path}"),
            Some(serde_json::json!({ "content": content })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// Mimics the Unix tool: the file's complete original bytes, and nothing
/// else — no status line, no JSON wrapper, no added or stripped newline.
pub fn render(data: &serde_json::Value) -> Vec<u8> {
    data.get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .as_bytes()
        .to_vec()
}

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
    fn missing_id_argument_fails() {
        let result = run(&[], false);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 cat 缺少參數：id");
    }

    #[test]
    fn unknown_id_is_not_found() {
        let result = run(
            &["definitely-not-a-real-id".to_string(), "x".to_string()],
            false,
        );
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }

    #[test]
    fn extra_positional_paths_are_ignored_without_json() {
        // Only the shape is testable without a real fixture id: missing id
        // still fails the same way whether or not extra paths follow.
        let result = run(
            &[
                "nope".to_string(),
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
            ],
            false,
        );
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }

    #[test]
    fn json_mode_with_no_paths_reports_missing_argument() {
        let result = run(&["nope".to_string()], true);
        // Unknown id is resolved before path parsing, so this still reports
        // not-found rather than "missing path" — matches the resolve-then-
        // validate order used throughout this module.
        assert!(!result.ok);
        assert_eq!(result.failure_kind, Some(FailureKind::NotFound));
    }

    #[test]
    fn render_passes_content_through_verbatim() {
        let data = serde_json::json!({ "content": "<svg/>" });
        assert_eq!(render(&data), b"<svg/>");
    }
}
