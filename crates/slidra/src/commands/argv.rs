// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! Shared argv-parsing helpers for every multi-token command family
//! (`element`/`text`/`textbox`/`comment`) — mirroring the original CLI's
//! own private helpers of the same names
//! (`requirePositional`/`optionalFlag`/`requireFlag`/`requireNumberFlag`/
//! `optionalNumberFlag`/`hasFlag`/`requireIdList`), which every one of that
//! file's ~40 command branches shared. One Rust module for the same reason:
//! this is genuinely one set of parsing rules the original never duplicated,
//! not a candidate for the "each command family keeps its own copy"
//! posture `element::edit`/`element::group`'s doc comments describe for
//! their own, much smaller, structural helpers.
//!
//! Every function here operates on `args`: the positional/flag tokens
//! AFTER the full multi-token command name has already been consumed by
//! `commands::resolve_takeover` (e.g. for `element move`, `args` starts at
//! whatever followed those two words) — mirrors `argv.ts`'s own `rest`/
//! `args` slices, which are always taken after `case "element":`'s `rest =
//! argvAfterCommandName.slice(1)`-equivalent split.

use crate::errors::{SlidraError, SlidraResult};

fn is_flag_like(value: &str) -> bool {
    value.starts_with("--")
}

/// A positional argument at `index`. A flag-shaped value in that slot (a
/// `new element-ids --dx` typo, `--dx` where `element-ids` belongs) means
/// the positional itself was omitted — reporting "missing" is more
/// accurate than accepting a flag token as data.
pub fn require_positional<'a>(
    args: &'a [String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> SlidraResult<&'a str> {
    match args.get(index) {
        Some(value) if !is_flag_like(value) => Ok(value.as_str()),
        _ => Err(SlidraError::invalid(format!(
            "command {command} missing argument: {arg_name}"
        ))),
    }
}

/// Same as `require_positional`, minus the `is_flag_like` check: a
/// presentation id is minted by `generate_opaque_id` (9 random bytes,
/// base64url-encoded — the alphabet includes `-`), so roughly 1 in 4096
/// ids happen to start with `--`. The id is not something a caller
/// chooses, so it must never be rejected as "missing" for looking
/// flag-shaped.
pub fn require_id_positional<'a>(
    args: &'a [String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> SlidraResult<&'a str> {
    match args.get(index) {
        Some(value) => Ok(value.as_str()),
        None => Err(SlidraError::invalid(format!(
            "command {command} missing argument: {arg_name}"
        ))),
    }
}

/// A "last positional taken by fixed index verbatim" value — `element name
/// set`'s `name`, `element style set`'s `value`, `text set`'s `new-text`,
/// `comment add`'s `text`. These, unlike every other positional, are
/// fetched by raw index in `argv.ts` (`nameArgs[3]`, not
/// `requirePositional(nameArgs, 3, ...)`) and only ever reject the slot
/// being wholly ABSENT — never reject a flag-shaped value the way
/// `require_positional` does, because the value being taken verbatim may
/// legitimately equal a literal string like `"--force"` (an element
/// genuinely named that, or text content that happens to start with two
/// dashes). Do not swap this for `require_positional` at a call site that
/// takes one of these fields — that would silently reject legal input
/// `argv.ts` accepts.
pub fn require_raw_positional<'a>(
    args: &'a [String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> SlidraResult<&'a str> {
    match args.get(index) {
        Some(value) => Ok(value.as_str()),
        None => Err(SlidraError::invalid(format!(
            "command {command} missing argument: {arg_name}"
        ))),
    }
}

/// A `--force` that may ONLY appear at exactly `index` (`text set`'s
/// `new-text`, `textbox width`'s `width`, `textbox align`'s `align` all fix
/// `--force` to the position right after their own last positional).
/// Absent -> `false`; the literal string `"--force"` there -> `true`;
/// anything else in that slot is an unknown trailing argument, not a
/// missing flag — mirrors `argv.ts`'s `requireTrailingForceFlag`.
pub fn require_trailing_force_flag(
    args: &[String],
    index: usize,
    command: &str,
) -> SlidraResult<bool> {
    match args.get(index) {
        None => Ok(false),
        Some(value) if value == "--force" => Ok(true),
        Some(value) => Err(SlidraError::invalid(format!(
            "command {command} unknown argument: {value}"
        ))),
    }
}

/// The value following `flag` in `args`, or `None` when the flag is simply
/// absent. `Err` when the flag is present but has no value (end of args, or
/// the next token is itself flag-shaped).
pub fn optional_flag<'a>(args: &'a [String], flag: &str) -> SlidraResult<Option<&'a str>> {
    let Some(index) = args.iter().position(|arg| arg == flag) else {
        return Ok(None);
    };
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(Some(value.as_str())),
        _ => Err(SlidraError::invalid(format!("{flag} missing value"))),
    }
}

/// Same as `optional_flag`, but the flag itself must be present.
pub fn require_flag<'a>(args: &'a [String], flag: &str, command: &str) -> SlidraResult<&'a str> {
    match optional_flag(args, flag)? {
        Some(value) => Ok(value),
        None => Err(SlidraError::invalid(format!(
            "command {command} missing argument: {flag}"
        ))),
    }
}

/// Approximates JS's `Number(raw)` coercion for the shapes a numeric CLI
/// flag actually receives in practice: decimal, exponent notation, a
/// leading `+`/`-`, surrounding whitespace trimmed, and an empty (or
/// whitespace-only) string coercing to `0` (`Number("") === 0` in JS).
/// Deliberately NOT a byte-exact port of `Number()`: hex/octal/binary
/// literal coercion (`Number("0x10") === 16`) is not reproduced — no CLI
/// flag in this ticket's contract table exercises that shape, and Rust's
/// `str::parse::<f64>` has no built-in equivalent to special-case for.
fn parse_number_like_js(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok()
}

pub fn require_number_flag(args: &[String], flag: &str, command: &str) -> SlidraResult<f64> {
    let raw = require_flag(args, flag, command)?;
    match parse_number_like_js(raw) {
        Some(value) if value.is_finite() => Ok(value),
        _ => Err(SlidraError::invalid(format!(
            "{flag} is not a valid number: {raw}"
        ))),
    }
}

pub fn optional_number_flag(
    args: &[String],
    flag: &str,
    _command: &str,
) -> SlidraResult<Option<f64>> {
    let Some(raw) = optional_flag(args, flag)? else {
        return Ok(None);
    };
    match parse_number_like_js(raw) {
        Some(value) if value.is_finite() => Ok(Some(value)),
        _ => Err(SlidraError::invalid(format!(
            "{flag} is not a valid number: {raw}"
        ))),
    }
}

/// A bare boolean flag with no value (`--force`). Presence anywhere in
/// `args` is enough — order relative to other flags does not matter.
pub fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

/// Splits a comma-separated element-id positional into a real `Vec<String>`
/// — no empty tokens (`el-1,,el-2`), no surrounding whitespace kept per
/// token.
pub fn require_id_list(args: &[String], index: usize, command: &str) -> SlidraResult<Vec<String>> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_positional_rejects_a_flag_shaped_value_as_missing() {
        let args = vec!["--dx".to_string(), "10".to_string()];
        let err = require_positional(&args, 0, "element move", "element-ids").unwrap_err();
        assert_eq!(
            err.message(),
            "command element move missing argument: element-ids"
        );
    }

    #[test]
    fn require_id_positional_accepts_a_dash_prefixed_id() {
        let args = vec!["--IXET6Q29_h".to_string(), "slides/001.svg".to_string()];
        assert_eq!(
            require_id_positional(&args, 0, "element insert", "id").unwrap(),
            "--IXET6Q29_h"
        );
    }

    #[test]
    fn require_id_positional_still_rejects_a_missing_positional() {
        let args: Vec<String> = vec![];
        let err = require_id_positional(&args, 0, "element insert", "id").unwrap_err();
        assert_eq!(err.message(), "command element insert missing argument: id");
    }

    #[test]
    fn optional_flag_returns_none_when_absent_and_errors_when_missing_a_value() {
        let args = vec!["--force".to_string()];
        assert_eq!(optional_flag(&args, "--dx").unwrap(), None);
        let err = optional_flag(&args, "--force").unwrap_err();
        assert_eq!(err.message(), "--force missing value");
    }

    #[test]
    fn require_number_flag_rejects_non_finite_and_non_numeric() {
        let args = vec!["--dx".to_string(), "abc".to_string()];
        let err = require_number_flag(&args, "--dx", "element move").unwrap_err();
        assert_eq!(err.message(), "--dx is not a valid number: abc");
    }

    #[test]
    fn require_number_flag_accepts_negative_and_exponent_forms() {
        let args = vec!["--dx".to_string(), "-1.5e2".to_string()];
        assert_eq!(
            require_number_flag(&args, "--dx", "element move").unwrap(),
            -150.0
        );
    }

    #[test]
    fn empty_string_flag_value_coerces_to_zero_like_js_number() {
        let args = vec!["--dx".to_string(), "".to_string()];
        assert_eq!(
            require_number_flag(&args, "--dx", "element move").unwrap(),
            0.0
        );
    }

    #[test]
    fn require_id_list_splits_trims_and_rejects_empty_tokens() {
        let args = vec!["ignored".to_string(), "el-1, el-2".to_string()];
        let ids = require_id_list(&args, 1, "element move").unwrap();
        assert_eq!(ids, vec!["el-1".to_string(), "el-2".to_string()]);

        let bad = vec!["ignored".to_string(), "el-1,,el-2".to_string()];
        let err = require_id_list(&bad, 1, "element move").unwrap_err();
        assert_eq!(
            err.message(),
            "command element move\'s element list has invalid format: el-1,,el-2"
        );
    }

    #[test]
    fn has_flag_finds_it_anywhere() {
        let args = vec!["el-1".to_string(), "--force".to_string()];
        assert!(has_flag(&args, "--force"));
        assert!(!has_flag(&args, "--dx"));
    }
}
