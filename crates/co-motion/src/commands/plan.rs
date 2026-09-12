//! `co-motion plan set|list|delete` (#303, ADR-0018): the presentation's
//! plan files under `plan/`. Reading is `cat <id> plan/outline.md`.

use crate::commands::argv;
use crate::plan;
use crate::result::{CommandResult, FailureKind};

pub fn run(args: &[String]) -> CommandResult {
    let sub = args.first().map(String::as_str);
    let rest: &[String] = args.get(1..).unwrap_or(&[]);
    match sub {
        Some("set") => run_set(rest),
        Some("list") => run_list(rest),
        Some("delete") => run_delete(rest),
        other => CommandResult::failure(
            format!("未知的子命令：plan {}", other.unwrap_or("")),
            FailureKind::Failed,
        ),
    }
}

fn run_set(args: &[String]) -> CommandResult {
    const COMMAND: &str = "plan set";
    let id = match argv::require_id_positional(args, 0, COMMAND, "presentation-id") {
        Ok(v) => v,
        Err(err) => return CommandResult::from_error(&err),
    };
    let name = match argv::require_positional(args, 1, COMMAND, "name") {
        Ok(v) => v,
        Err(err) => return CommandResult::from_error(&err),
    };
    let content = match argv::require_raw_positional(args, 2, COMMAND, "content") {
        Ok(v) => v,
        Err(err) => return CommandResult::from_error(&err),
    };
    // `content` is a raw positional, so `--force` can only be pinned right
    // after it — the same shape `text set`/`textbox width` use.
    let force = match argv::require_trailing_force_flag(args, 3, COMMAND) {
        Ok(v) => v,
        Err(err) => return CommandResult::from_error(&err),
    };
    match plan::set_plan(id, name, content, force) {
        Ok(path) => CommandResult::success(
            format!("已寫入 {path}"),
            Some(serde_json::json!({ "path": path })),
        ),
        Err(err) => CommandResult::from_error(&err),
    }
}

fn run_list(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "plan list", "presentation-id") {
        Ok(v) => v,
        Err(err) => return CommandResult::from_error(&err),
    };
    match plan::list_plans(id) {
        Ok(entries) => {
            let plans: Vec<serde_json::Value> = entries
                .iter()
                .map(|entry| match &entry.status {
                    Some(status) => serde_json::json!({ "file": entry.file, "status": status }),
                    None => serde_json::json!({ "file": entry.file }),
                })
                .collect();
            CommandResult::success(
                format!("共 {} 個計畫檔", entries.len()),
                Some(serde_json::json!({ "plans": plans })),
            )
        }
        Err(err) => CommandResult::from_error(&err),
    }
}

fn run_delete(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "plan delete", "presentation-id") {
        Ok(v) => v,
        Err(err) => return CommandResult::from_error(&err),
    };
    let name = args.get(1).map(String::as_str);
    match plan::delete_plan(id, name) {
        Ok(path) => CommandResult {
            ok: true,
            data: None,
            message: format!("已刪除 {path}"),
            failure_kind: None,
        },
        Err(err) => CommandResult::from_error(&err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_subcommand_is_rejected() {
        let result = run(&["frobnicate".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.message, "未知的子命令：plan frobnicate");
    }

    #[test]
    fn set_requires_name_and_content() {
        let result = run(&["set".to_string(), "id".to_string()]);
        assert_eq!(result.message, "命令 plan set 缺少參數：name");
        let result = run(&["set".to_string(), "id".to_string(), "outline".to_string()]);
        assert_eq!(result.message, "命令 plan set 缺少參數：content");
    }

    #[test]
    fn set_rejects_an_unknown_plan_name_before_touching_the_workspace() {
        let result = run(&[
            "set".to_string(),
            "id".to_string(),
            "brief".to_string(),
            "x".to_string(),
        ]);
        assert!(!result.ok);
        assert!(
            result.message.contains("outline 或 design-spec"),
            "{}",
            result.message
        );
    }
}
