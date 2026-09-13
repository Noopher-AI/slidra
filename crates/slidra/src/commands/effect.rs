// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `slidra effect add / remove / move / set / list`. Ported from
//! `packages/cli/src/argv.ts`'s `"effect"` case (argv parsing) plus
//! `packages/cli/src/commands/effect/*.ts` (handlers) and
//! `packages/core/src/workspace.ts`'s `*SlideEffect*` functions (workspace
//! orchestration: resolve, confirm listed, read, mutate, write).
//!
//! `effect list` additionally builds `steps`/`transition` (plan 4.1/4.3) —
//! the "step plan" computation this ticket moves out of the browser
//! (`apps/web/src/player-plan.ts`'s former `deriveSteps`/`parseEffects`
//! call) and into the CLI/server.

use crate::effects::edit::{
    AddEffectInput, SetEffectInput, add_effects, move_effect, remove_effects, set_effect,
};
use crate::effects::{Effect, derive_steps};
use crate::errors::{SlidraError, SlidraResult};
use crate::result::{CommandResult, FailureKind};
use crate::slide::transition::{SlideTransition, read_slide_transition};
use crate::workspace;
use serde_json::{Value, json};

fn failure_kind_for(err: &SlidraError) -> FailureKind {
    match err {
        SlidraError::NotFound(_) => FailureKind::NotFound,
        SlidraError::InvalidRequest(_) => FailureKind::Failed,
    }
}

/// An argv-parsing failure (`packages/cli/src/argv.ts`'s own `SlidraError`
/// throws): exit 1, no `failureKind` in the `--json` envelope — distinct
/// from a business-logic failure, which always carries one (`NotFound` or
/// `Failed`).
fn argv_error(message: String) -> CommandResult {
    CommandResult {
        ok: false,
        data: None,
        message,
        failure_kind: None,
    }
}

fn is_flag_like(value: &str) -> bool {
    value.starts_with("--")
}

fn require_positional(
    args: &[String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> SlidraResult<String> {
    match args.get(index) {
        Some(value) if !value.is_empty() && !is_flag_like(value) => Ok(value.clone()),
        _ => Err(SlidraError::invalid(format!(
            "command {command} missing argument: {arg_name}"
        ))),
    }
}

/// Same as `require_positional`, minus the `is_flag_like` check — a
/// presentation id minted by `generate_opaque_id` has roughly 1/4096 odds
/// of starting with `--`, and the product mints it, not the caller.
fn require_id_positional(
    args: &[String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> SlidraResult<String> {
    match args.get(index) {
        Some(value) if !value.is_empty() => Ok(value.clone()),
        _ => Err(SlidraError::invalid(format!(
            "command {command} missing argument: {arg_name}"
        ))),
    }
}

fn require_flag(args: &[String], flag: &str, command: &str) -> SlidraResult<String> {
    let Some(index) = args.iter().position(|a| a == flag) else {
        return Err(SlidraError::invalid(format!(
            "command {command} missing argument: {flag}"
        )));
    };
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(value.clone()),
        _ => Err(SlidraError::invalid(format!("{flag} missing value"))),
    }
}

fn optional_flag(args: &[String], flag: &str) -> SlidraResult<Option<String>> {
    let Some(index) = args.iter().position(|a| a == flag) else {
        return Ok(None);
    };
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(Some(value.clone())),
        _ => Err(SlidraError::invalid(format!("{flag} missing value"))),
    }
}

/// Mirrors JS's `Number(string)` coercion closely enough for argv flags:
/// trims, empty string is `0` (not `NaN` — a real difference from
/// `effects::mod`'s `parse_seconds_attr`, which treats an empty attribute
/// as illegal; argv.ts's plain `Number(raw)` has no such special case).
/// KNOWN GAP: hex/octal/binary literals ("0x10") are not accepted, same
/// caveat as every other ported numeric-coercion site in this crate.
fn js_number(raw: &str) -> f64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

fn optional_number_flag(args: &[String], flag: &str) -> SlidraResult<Option<f64>> {
    let Some(raw) = optional_flag(args, flag)? else {
        return Ok(None);
    };
    let value = js_number(&raw);
    if !value.is_finite() {
        return Err(SlidraError::invalid(format!(
            "{flag} is not a valid number: {raw}"
        )));
    }
    Ok(Some(value))
}

/// `effect add`'s comma-separated element-id positional into a real
/// `Vec<String>`.
fn require_id_list(args: &[String], index: usize, command: &str) -> SlidraResult<Vec<String>> {
    let raw = require_positional(args, index, command, "element-ids")?;
    let ids: Vec<String> = raw
        .split(',')
        .map(|token| token.trim().to_string())
        .collect();
    if ids.iter().any(|token| token.is_empty()) {
        return Err(SlidraError::invalid(format!(
            "command {command}\'s element list has invalid format: {raw}"
        )));
    }
    Ok(ids)
}

fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

/// `effect remove`'s comma-separated 1-based index positional into a real
/// `Vec<i64>`.
fn require_index_list(args: &[String], index: usize, command: &str) -> SlidraResult<Vec<i64>> {
    let raw = require_positional(args, index, command, "index-list")?;
    let mut out = Vec::new();
    for token in raw.split(',') {
        let value = js_number(token.trim());
        if !is_integer(value) {
            return Err(SlidraError::invalid(format!(
                "command {command}\'s effect item number has invalid format: {raw}"
            )));
        }
        out.push(value as i64);
    }
    Ok(out)
}

/// A single 1-based effect-item index positional (`effect move` / `effect
/// set`).
fn require_index(args: &[String], index: usize, command: &str) -> SlidraResult<i64> {
    let raw = require_positional(args, index, command, "index")?;
    let value = js_number(&raw);
    if !is_integer(value) {
        return Err(SlidraError::invalid(format!(
            "command {command}\'s effect item number is not a valid integer: {raw}"
        )));
    }
    Ok(value as i64)
}

/// Shared workspace orchestration for the four write commands: resolve the
/// work dir, confirm the real file exists, confirm it is a declared slide
/// or template, and read its current content. Mirrors
/// `packages/core/src/workspace.ts`'s per-function preamble
/// (`resolveVirtualFilePath` before `assertSlidePathListed`).
fn read_slide_for_write(id: &str, slide_path: &str) -> SlidraResult<String> {
    let work_dir = workspace::resolve_work_dir(id)?;
    workspace::virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    workspace::write::assert_slide_path_listed(&work_dir, slide_path)?;
    workspace::virtual_fs::read_virtual_file(&work_dir, slide_path)
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

pub fn add(args: &[String]) -> CommandResult {
    match parse_add(args) {
        Ok(parsed) => run_add(parsed),
        Err(err) => argv_error(err.message().to_string()),
    }
}

struct AddArgs {
    id: String,
    slide_path: String,
    element_ids: Vec<String>,
    input: AddEffectInput,
}

fn parse_add(args: &[String]) -> SlidraResult<AddArgs> {
    const COMMAND: &str = "effect add";
    let id = require_id_positional(args, 0, COMMAND, "presentation-id")?;
    let slide_path = require_positional(args, 1, COMMAND, "slide-path")?;
    let element_ids = require_id_list(args, 2, COMMAND)?;
    let family = require_flag(args, "--family", COMMAND)?;
    if !["enter", "emphasis", "exit", "path", "media"].contains(&family.as_str()) {
        return Err(SlidraError::invalid(format!(
            "effect add unsupported family: {family}"
        )));
    }
    let effect = require_flag(args, "--effect", COMMAND)?;
    let start = optional_flag(args, "--start")?;
    if let Some(start) = &start {
        if !["on-click", "with-previous", "after-previous"].contains(&start.as_str()) {
            return Err(SlidraError::invalid(format!(
                "effect add unsupported start: {start}"
            )));
        }
    }
    let duration = optional_number_flag(args, "--duration")?;
    let delay = optional_number_flag(args, "--delay")?;
    let d = optional_flag(args, "--d")?;
    let index = optional_number_flag(args, "--index")?;
    Ok(AddArgs {
        id,
        slide_path,
        element_ids,
        input: AddEffectInput {
            family,
            effect,
            start,
            duration,
            delay,
            d,
            index,
        },
    })
}

fn run_add(parsed: AddArgs) -> CommandResult {
    let AddArgs {
        id,
        slide_path,
        element_ids,
        input,
    } = parsed;
    let outcome = (|| -> SlidraResult<()> {
        let original = read_slide_for_write(&id, &slide_path)?;
        let updated = add_effects(&original, &slide_path, &element_ids, &input)?;
        workspace::write::write_presentation_file(&id, &slide_path, &updated)
    })();
    match outcome {
        Ok(()) => CommandResult::success(
            format!(
                "added {}/{} effect for {} elements in {slide_path}",
                element_ids.len(),
                input.family,
                input.effect
            ),
            Some(json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

pub fn remove(args: &[String]) -> CommandResult {
    const COMMAND: &str = "effect remove";
    let id = match require_id_positional(args, 0, COMMAND, "presentation-id") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let slide_path = match require_positional(args, 1, COMMAND, "slide-path") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let indices = match require_index_list(args, 2, COMMAND) {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };

    let outcome = (|| -> SlidraResult<()> {
        let original = read_slide_for_write(&id, &slide_path)?;
        let updated = remove_effects(&original, &slide_path, &indices)?;
        workspace::write::write_presentation_file(&id, &slide_path, &updated)
    })();
    match outcome {
        // `indices.length` here is the count BEFORE dedup — the same count
        // the argv positional itself carried, not the effective removal
        // count (plan 3.3: "length before dedup").
        Ok(()) => CommandResult::success(
            format!("removed {} effect items from {slide_path}", indices.len()),
            Some(json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

pub fn move_cmd(args: &[String]) -> CommandResult {
    const COMMAND: &str = "effect move";
    let id = match require_id_positional(args, 0, COMMAND, "presentation-id") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let slide_path = match require_positional(args, 1, COMMAND, "slide-path") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let index = match require_index(args, 2, COMMAND) {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let direction = match require_positional(args, 3, COMMAND, "direction") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    if direction != "up" && direction != "down" {
        return argv_error(format!("effect move unsupported direction: {direction}"));
    }

    let outcome = (|| -> SlidraResult<()> {
        let original = read_slide_for_write(&id, &slide_path)?;
        let updated = move_effect(&original, &slide_path, index, &direction)?;
        workspace::write::write_presentation_file(&id, &slide_path, &updated)
    })();
    match outcome {
        Ok(()) => CommandResult::success(
            format!(
                "effect item #{index} in {slide_path} has been {}",
                if direction == "up" {
                    "move up"
                } else {
                    "move down"
                }
            ),
            Some(json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

pub fn set(args: &[String]) -> CommandResult {
    const COMMAND: &str = "effect set";
    let id = match require_id_positional(args, 0, COMMAND, "presentation-id") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let slide_path = match require_positional(args, 1, COMMAND, "slide-path") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let index = match require_index(args, 2, COMMAND) {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let effect = match optional_flag(args, "--effect") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let start = match optional_flag(args, "--start") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    if let Some(start) = &start {
        if !["on-click", "with-previous", "after-previous"].contains(&start.as_str()) {
            return argv_error(format!("effect set unsupported start: {start}"));
        }
    }
    let duration = match optional_number_flag(args, "--duration") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let delay = match optional_number_flag(args, "--delay") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let d = match optional_flag(args, "--d") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };

    let input = SetEffectInput {
        effect,
        start,
        duration,
        delay,
        d,
    };
    let outcome = (|| -> SlidraResult<()> {
        let original = read_slide_for_write(&id, &slide_path)?;
        let updated = set_effect(&original, &slide_path, index, &input)?;
        workspace::write::write_presentation_file(&id, &slide_path, &updated)
    })();
    match outcome {
        Ok(()) => CommandResult::success(
            format!("updated effect item #{index} in {slide_path}"),
            Some(json!({})),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

pub fn list(args: &[String]) -> CommandResult {
    const COMMAND: &str = "effect list";
    let id = match require_id_positional(args, 0, COMMAND, "presentation-id") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };
    let slide_path = match require_positional(args, 1, COMMAND, "slide-path") {
        Ok(v) => v,
        Err(err) => return argv_error(err.message().to_string()),
    };

    match list_data(&id, &slide_path) {
        Ok((count, data)) => {
            CommandResult::success(format!("{slide_path} has {count} effect items"), Some(data))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

/// Builds `effect list`'s `data`: `effects` (1-based `index`, matching
/// `effect move`/`set`/`remove`'s own addressing), `steps` (derived, plan
/// 4.1's `derive_steps`), and `transition` (always present, defaulted when
/// absent — plan 4.1's contract table).
fn list_data(id: &str, slide_path: &str) -> SlidraResult<(usize, Value)> {
    let work_dir = workspace::resolve_work_dir(id)?;
    workspace::virtual_fs::resolve_virtual_file_path(&work_dir, slide_path)?;
    workspace::write::assert_slide_path_listed(&work_dir, slide_path)?;
    let original = workspace::virtual_fs::read_virtual_file(&work_dir, slide_path)?;

    let effects = crate::effects::edit::read_effect_list(&original, slide_path)?;
    let transition = read_slide_transition(&original)?;

    // `effect move`/`set`/`remove` take a 1-based index; the internal
    // `Effect.index` is 0-based (document position) — translate here for
    // round-trip use, matching `packages/cli/src/commands/effect/list.ts`.
    let one_based: Vec<Effect> = effects
        .iter()
        .map(|effect| {
            let mut cloned = effect.clone();
            cloned.index += 1;
            cloned
        })
        .collect();
    let steps = derive_steps(&one_based)?;

    let mut data = serde_json::Map::new();
    data.insert(
        "effects".to_string(),
        Value::Array(one_based.iter().map(effect_to_json).collect()),
    );
    data.insert(
        "steps".to_string(),
        Value::Array(
            steps
                .iter()
                .map(|step| json!({ "effects": step.effects.iter().map(effect_to_json).collect::<Vec<_>>() }))
                .collect(),
        ),
    );
    data.insert("transition".to_string(), transition_to_json(&transition));

    Ok((effects.len(), Value::Object(data)))
}

fn effect_to_json(effect: &Effect) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("target".to_string(), Value::String(effect.target.clone()));
    map.insert("family".to_string(), Value::String(effect.family.clone()));
    map.insert("effect".to_string(), Value::String(effect.effect.clone()));
    map.insert("start".to_string(), Value::String(effect.start.clone()));
    map.insert("duration".to_string(), json_number(effect.duration));
    map.insert("delay".to_string(), json_number(effect.delay));
    if let Some(d) = &effect.d {
        map.insert("d".to_string(), Value::String(d.clone()));
    }
    map.insert(
        "index".to_string(),
        Value::Number((effect.index as i64).into()),
    );
    Value::Object(map)
}

fn transition_to_json(transition: &SlideTransition) -> Value {
    json!({
        "enter": { "effect": transition.enter.effect.as_str(), "duration": json_number(transition.enter.duration) },
        "exit": { "effect": transition.exit.effect.as_str(), "duration": json_number(transition.exit.duration) },
    })
}

/// `serde_json`'s `f64` serialization always prints a decimal point (e.g.
/// `0.0`), but `JSON.stringify(0)` in the TS original prints `0` — the two
/// engines must agree byte-for-byte for `tests/cli_golden.rs`'s Rust<->Node
/// `--json` comparison. An integral value is re-encoded as a JSON integer;
/// anything else keeps its `f64` form.
fn json_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_missing_presentation_id_is_argv_error_without_failure_kind() {
        let result = add(&[]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command effect add missing argument: presentation-id"
        );
        assert_eq!(result.failure_kind, None);
    }

    #[test]
    fn require_id_positional_accepts_a_dash_prefixed_id() {
        let args = vec!["--IXET6Q29_h".to_string()];
        assert_eq!(
            require_id_positional(&args, 0, "effect list", "presentation-id").unwrap(),
            "--IXET6Q29_h"
        );
    }

    #[test]
    fn require_id_positional_still_rejects_a_missing_positional() {
        let args: Vec<String> = vec![];
        let err = require_id_positional(&args, 0, "effect list", "presentation-id").unwrap_err();
        assert_eq!(
            err.message(),
            "command effect list missing argument: presentation-id"
        );
    }

    #[test]
    fn add_unsupported_family_is_rejected_before_any_workspace_lookup() {
        let result = add(&[
            "pid".to_string(),
            "slides/001.svg".to_string(),
            "el1".to_string(),
            "--family".to_string(),
            "bogus".to_string(),
            "--effect".to_string(),
            "fade".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(result.message, "effect add unsupported family: bogus");
        assert_eq!(result.failure_kind, None);
    }

    #[test]
    fn move_unsupported_direction_is_rejected() {
        let result = move_cmd(&[
            "pid".to_string(),
            "slides/001.svg".to_string(),
            "1".to_string(),
            "sideways".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "effect move unsupported direction: sideways"
        );
    }

    #[test]
    fn remove_index_list_with_non_integer_is_rejected() {
        let result = remove(&[
            "pid".to_string(),
            "slides/001.svg".to_string(),
            "1,x".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command effect remove\'s effect item number has invalid format: 1,x"
        );
    }

    #[test]
    fn set_index_not_an_integer_is_rejected() {
        let result = set(&[
            "pid".to_string(),
            "slides/001.svg".to_string(),
            "1.5".to_string(),
        ]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command effect set\'s effect item number is not a valid integer: 1.5"
        );
    }

    #[test]
    fn json_number_prints_integral_values_without_a_decimal_point() {
        assert_eq!(json_number(0.0), Value::from(0));
        assert_eq!(
            json_number(0.6),
            serde_json::Number::from_f64(0.6)
                .map(Value::Number)
                .unwrap()
        );
        assert_eq!(json_number(-1.0), Value::from(-1));
    }

    #[test]
    fn list_missing_id_is_argv_error() {
        let result = list(&[]);
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "command effect list missing argument: presentation-id"
        );
        assert_eq!(result.failure_kind, None);
    }
}
