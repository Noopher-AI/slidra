//! `co-motion template add|list|rename|delete`.

use crate::argv;
use crate::errors::CoMotionError;
use crate::result::{CommandResult, FailureKind};
use crate::slide::ops::{self, AddTemplateInput};

pub fn run(args: &[String]) -> CommandResult {
    let sub = args.first().map(String::as_str);
    let rest: &[String] = args.get(1..).unwrap_or(&[]);

    match sub {
        Some("add") => run_add(rest),
        Some("list") => run_list(rest),
        Some("rename") => run_rename(rest),
        Some("delete") => run_delete(rest),
        other => CommandResult::failure(
            format!("未知的子命令：template {}", other.unwrap_or("")),
            FailureKind::Failed,
        ),
    }
}

fn run_add(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "template add", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let from = match argv::optional_flag(args, "--from") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let name = match argv::optional_flag(args, "--name") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::add_template(&id, AddTemplateInput { from, name }) {
        Ok(result) => CommandResult::success(
            format!("已建立範本 {}", result.template_path),
            Some(serde_json::json!({ "templatePath": result.template_path })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_list(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "template list", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::list_templates(&id) {
        Ok(templates) => {
            let message = format!("共 {} 個範本", templates.len());
            let data = serde_json::json!({
                "templates": templates.iter().map(|t| serde_json::json!({ "file": t.file, "name": t.name })).collect::<Vec<_>>(),
            });
            CommandResult::success(message, Some(data))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_rename(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "template rename", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let template_path = match argv::require_positional(args, 1, "template rename", "template-path")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let Some(new_name) = args.get(2) else {
        return CommandResult::failure(
            "命令 template rename 缺少參數：new-name".to_string(),
            FailureKind::Failed,
        );
    };
    match ops::rename_template(&id, &template_path, new_name) {
        // TS's handler type is `void` — no `data` key at all, in --json too.
        Ok(()) => CommandResult {
            ok: true,
            data: None,
            message: format!("已將範本改名為 {}", new_name.trim()),
            failure_kind: None,
        },
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn run_delete(args: &[String]) -> CommandResult {
    let id = match argv::require_positional(args, 0, "template delete", "presentation-id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let template_path = match argv::require_positional(args, 1, "template delete", "template-path")
    {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    match ops::delete_template(&id, &template_path) {
        Ok(()) => CommandResult {
            ok: true,
            data: None,
            message: format!("已刪除範本 {template_path}"),
            failure_kind: None,
        },
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
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
    fn unknown_subcommand_fails() {
        let result = run(&["frobnicate".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.message, "未知的子命令：template frobnicate");
    }

    #[test]
    fn rename_missing_new_name_fails_with_exact_message() {
        let result = run(&[
            "rename".to_string(),
            "id".to_string(),
            "templates/001.svg".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 template rename 缺少參數：new-name");
    }

    #[test]
    fn list_missing_id_fails() {
        let result = run(&["list".to_string()]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "命令 template list 缺少參數：presentation-id"
        );
    }
}
