// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra validate <presentation-id> [slide-path]` (#303): runs the
//! deterministic design rules in `crate::validate` and reports every
//! failure. Exit code is 1 when there are errors (see `main.rs`) — like
//! `effect list`'s empty-list exit, non-zero means "findings", not a fault.

use crate::commands::argv;
use crate::result::CommandResult;
use crate::validate::{ValidationReport, validate_presentation};

pub fn run(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "validate", "presentation-id") {
        Ok(v) => v,
        Err(err) => return CommandResult::from_error(&err),
    };
    let slide_path = args.get(1).map(String::as_str);
    match validate_presentation(id, slide_path) {
        Ok(report) => CommandResult::success(message_for(&report), Some(data_for(&report))),
        Err(err) => CommandResult::from_error(&err),
    }
}

fn message_for(report: &ValidationReport) -> String {
    let mut message = format!(
        "{} pages total, {} errors",
        report.checked,
        report.errors.len()
    );
    if report.without_plan {
        message.push_str("(no plan/ plan file, only validating geometry and skeleton)");
    }
    message
}

fn data_for(report: &ValidationReport) -> serde_json::Value {
    let errors: Vec<serde_json::Value> = report
        .errors
        .iter()
        .map(|e| {
            serde_json::json!({
                "slide": e.slide,
                "element": e.element,
                "rule": e.rule,
                "actual": e.actual,
                "limit": e.limit,
                "message": e.message,
            })
        })
        .collect();
    serde_json::json!({ "checked": report.checked, "errors": errors })
}

/// True when a successful `validate` result carries at least one error —
/// `main.rs` turns that into exit code 1.
pub fn has_findings(result: &CommandResult) -> bool {
    result.ok
        && result
            .data
            .as_ref()
            .and_then(|d| d.get("errors"))
            .and_then(|e| e.as_array())
            .is_some_and(|errors| !errors.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_id_is_rejected() {
        let result = run(&[]);
        assert_eq!(
            result.message,
            "command validate missing argument: presentation-id"
        );
    }

    #[test]
    fn has_findings_reads_the_errors_array() {
        let empty =
            CommandResult::success("x", Some(serde_json::json!({ "checked": 1, "errors": [] })));
        assert!(!has_findings(&empty));
        let some = CommandResult::success(
            "x",
            Some(serde_json::json!({ "checked": 1, "errors": [{ "rule": "structure.notes" }] })),
        );
        assert!(has_findings(&some));
    }
}
