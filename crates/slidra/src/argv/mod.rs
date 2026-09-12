// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! Shared argv parsing helpers for the command handlers in `commands/`
//! (`require_positional`/`is_flag_like`/`require_flag`/`optional_flag`/
//! `require_number_flag`/`has_flag`). Every function at THIS module's root
//! returns a plain `String` error message on failure — callers wrap it into
//! a `CommandResult::failure` themselves (argv errors are reported the same
//! way as any other command failure, `FailureKind::Failed`, never a
//! separate exit path). This module folds what was originally a
//! single-file `argv.rs` into this directory module (rather than kept as a
//! sibling `argv.rs`, which Rust disallows alongside `argv/mod.rs`) so the
//! `chart`/`table`/`asset` command families below can live at
//! `argv::chart`/`argv::table`/`argv::asset`.
//!
//! `chart`/`table`/`asset` need every one of these SAME primitives, but
//! returning `SlidraError` (not `String`), since their own `parse`
//! functions build on `SlidraResult` and propagate with `?`. Rather than
//! rewrite every already-merged `String`-returning call site above (11
//! command families) OR every `SlidraError`-propagating call site in
//! `argv::chart`/`argv::table`/`argv::asset` (26 commands), both toolkits
//! are kept side by side: this module's own root keeps its original
//! `String` contract untouched, and `ct` below (private; visible to this
//! module and its `chart`/`table`/`asset` children) holds the
//! `SlidraError` contract. `collect_repeated_flag`/`parse_js_number` have
//! no `String`-returning equivalent above, so they stay at this module's
//! root — `parse_js_number` in particular is called as
//! `crate::argv::parse_js_number` from `chart`/`table`'s own model/edit/csv
//! modules, not just from argv parsing.

pub mod asset;
pub mod chart;
pub mod table;

/// A flag-shaped value (`--foo`) in a positional slot means the positional
/// argument itself was omitted.
pub fn is_flag_like(value: &str) -> bool {
    value.starts_with("--")
}

/// The positional argument at `index`, or an error naming `command`/`arg_name`
/// when it is missing or flag-shaped.
pub fn require_positional(
    args: &[String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> Result<String, String> {
    match args.get(index) {
        Some(value) if !value.is_empty() && !is_flag_like(value) => Ok(value.clone()),
        _ => Err(format!("command {command} missing argument: {arg_name}")),
    }
}

/// Same as `require_positional`, minus the `is_flag_like` check: a
/// presentation id is minted by `generate_opaque_id` (9 random bytes,
/// base64url-encoded — `id.rs`'s alphabet includes `-`), so roughly 1 in
/// 4096 ids happen to start with `--`. The product itself mints these ids;
/// a user has no way to avoid one. Rejecting them as "missing" here would
/// make an already-open presentation permanently unreachable through this
/// argv slot. Every other check (missing, empty string) is unchanged.
pub fn require_id_positional(
    args: &[String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> Result<String, String> {
    match args.get(index) {
        Some(value) if !value.is_empty() => Ok(value.clone()),
        _ => Err(format!("command {command} missing argument: {arg_name}")),
    }
}

/// The value following `flag` in `args`, or an error when the flag is
/// absent or has no legal value.
pub fn require_flag(args: &[String], flag: &str, command: &str) -> Result<String, String> {
    let Some(index) = args.iter().position(|a| a == flag) else {
        return Err(format!("command {command} missing argument: {flag}"));
    };
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(value.clone()),
        _ => Err(format!("{flag} missing value")),
    }
}

/// Same as `require_flag`, but returns `Ok(None)` when the flag is simply
/// absent.
pub fn optional_flag(args: &[String], flag: &str) -> Result<Option<String>, String> {
    let Some(index) = args.iter().position(|a| a == flag) else {
        return Ok(None);
    };
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(Some(value.clone())),
        _ => Err(format!("{flag} missing value")),
    }
}

pub fn require_number_flag(args: &[String], flag: &str, command: &str) -> Result<f64, String> {
    let raw = require_flag(args, flag, command)?;
    raw.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("{flag} is not a valid number: {raw}"))
}

pub fn optional_number_flag(args: &[String], flag: &str) -> Result<Option<f64>, String> {
    let Some(raw) = optional_flag(args, flag)? else {
        return Ok(None);
    };
    raw.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .map(Some)
        .ok_or_else(|| format!("{flag} is not a valid number: {raw}"))
}

/// A bare boolean flag with no value (`--force`, `--all`). Presence
/// anywhere in `args` is enough.
pub fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// Every value following a (possibly repeated) `flag` in `args` —
/// `chart data set --series`/`chart palette set --color`/
/// `chart axis set --right`.
pub fn collect_repeated_flag(
    args: &[String],
    flag: &str,
) -> Result<Vec<String>, crate::errors::SlidraError> {
    let mut values = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            match args.get(i + 1) {
                Some(value) if !is_flag_like(value) => {
                    values.push(value.clone());
                    i += 1;
                }
                _ => {
                    return Err(crate::errors::SlidraError::invalid(format!(
                        "{flag} missing value"
                    )));
                }
            }
        }
        i += 1;
    }
    Ok(values)
}

/// Mirrors JS's `Number(string)` coercion (ECMA-262 `ToNumber` for a
/// String) closely enough for this crate's argv/CSV numeric parsing, which
/// everywhere calls TS's bare `Number(raw)` immediately followed by a
/// `Number.isFinite` check — so the two edge cases that matter are: an
/// all-whitespace/empty string coerces to `0` (not an error), and a value
/// that fails to parse coerces to `NaN` (which the caller's `is_finite`
/// check then rejects the same way a `None` here would). Deliberately NOT
/// `str::parse::<f64>` alone: Rust's parser accepts `"inf"`/`"nan"` in any
/// case, which JS's `Number()` does not, but since every call site here
/// immediately filters on `is_finite()`, an accidental `Some(NaN)`/
/// `Some(inf)` from a spelling JS would reject is filtered out identically
/// to this function returning `None` for it — the two are behaviorally
/// indistinguishable to every caller, so no extra case-checking is done to
/// tell them apart.
///
/// KNOWN GAP (matches this codebase's convention of flagging rather than
/// silently assuming — see `svgnum.rs`/`slide/table_grid.rs`): JS's
/// `Number()` also accepts `0o`/`0b` (octal/binary) integer literals and
/// underscore-free scientific notation edge cases this function does not
/// special-case beyond `0x` (hex) and `Infinity`; real argv/CSV input in
/// this codebase is plain decimal, so this is believed unreachable in
/// practice.
pub fn parse_js_number(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16).ok().map(|value| value as f64);
    }
    trimmed.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_positional_rejects_missing_and_flag_shaped() {
        let args = vec!["--foo".to_string()];
        assert!(require_positional(&args, 0, "cmd", "path").is_err());
        assert_eq!(
            require_positional(&args, 1, "cmd", "path").unwrap_err(),
            "command cmd missing argument: path"
        );
    }

    #[test]
    fn require_positional_accepts_a_plain_value() {
        let args = vec!["hello".to_string()];
        assert_eq!(
            require_positional(&args, 0, "cmd", "path").unwrap(),
            "hello"
        );
    }

    #[test]
    fn require_id_positional_accepts_a_dash_prefixed_id() {
        let args = vec!["--IXET6Q29_h".to_string()];
        assert_eq!(
            require_id_positional(&args, 0, "cat", "id").unwrap(),
            "--IXET6Q29_h"
        );
    }

    #[test]
    fn require_id_positional_still_rejects_missing_and_empty() {
        let args = vec!["".to_string()];
        assert_eq!(
            require_id_positional(&args, 0, "cat", "id").unwrap_err(),
            "command cat missing argument: id"
        );
        assert_eq!(
            require_id_positional(&args, 1, "cat", "id").unwrap_err(),
            "command cat missing argument: id"
        );
    }

    #[test]
    fn require_flag_finds_value_after_flag() {
        let args = vec!["--width".to_string(), "100".to_string()];
        assert_eq!(require_flag(&args, "--width", "cmd").unwrap(), "100");
    }

    #[test]
    fn require_flag_missing_value_errors() {
        let args = vec!["--width".to_string()];
        assert_eq!(
            require_flag(&args, "--width", "cmd").unwrap_err(),
            "--width missing value"
        );
    }

    #[test]
    fn optional_flag_absent_is_none() {
        let args: Vec<String> = vec![];
        assert_eq!(optional_flag(&args, "--x").unwrap(), None);
    }

    #[test]
    fn require_number_flag_rejects_non_numeric() {
        let args = vec!["--width".to_string(), "abc".to_string()];
        assert_eq!(
            require_number_flag(&args, "--width", "cmd").unwrap_err(),
            "--width is not a valid number: abc"
        );
    }

    #[test]
    fn has_flag_detects_presence_anywhere() {
        let args = vec!["a".to_string(), "--force".to_string(), "b".to_string()];
        assert!(has_flag(&args, "--force"));
        assert!(!has_flag(&args, "--other"));
    }

    #[test]
    fn parse_js_number_empty_string_is_zero() {
        assert_eq!(parse_js_number(""), Some(0.0));
        assert_eq!(parse_js_number("   "), Some(0.0));
    }

    #[test]
    fn parse_js_number_plain_decimal() {
        assert_eq!(parse_js_number("12.5"), Some(12.5));
        assert_eq!(parse_js_number("-3"), Some(-3.0));
    }

    #[test]
    fn parse_js_number_garbage_is_none() {
        assert_eq!(parse_js_number("not-a-number"), None);
    }

    #[test]
    fn collect_repeated_flag_collects_every_occurrence_in_order() {
        let args = vec![
            "--series".to_string(),
            "a=1,2".to_string(),
            "--x".to_string(),
            "1".to_string(),
            "--series".to_string(),
            "b=3,4".to_string(),
        ];
        assert_eq!(
            collect_repeated_flag(&args, "--series").unwrap(),
            vec!["a=1,2".to_string(), "b=3,4".to_string()]
        );
    }
}

/// A second copy of this module's toolkit, returning `SlidraError`
/// instead of `String` — see this module's own doc comment for why it
/// lives here rather than replacing the root copy above.
/// `pub(super)` (visible throughout `argv` and its `chart`/`table`/`asset`
/// children, never outside `argv`) rather than `pub` — nothing outside this
/// module's own command families should reach for a second, differently-
/// erroring copy of `require_positional` when the root one above is
/// already `pub`.
mod ct {
    use crate::errors::SlidraError;

    /// A flag-shaped token: starts with `--`. A value in a positional or
    /// flag-value slot that looks like this means the actual value was
    /// omitted — e.g. `chart create <id> <path> --palette --grid` must not
    /// silently take `--grid` as `--palette`'s value.
    pub(super) fn is_flag_like(value: &str) -> bool {
        value.starts_with("--")
    }

    /// The positional argument at `index`, or a "missing argument" error naming
    /// `arg_name`. A flag-shaped value in this slot is treated the same as
    /// a missing one (see `is_flag_like`'s doc).
    pub(super) fn require_positional(
        args: &[String],
        index: usize,
        command: &str,
        arg_name: &str,
    ) -> Result<String, SlidraError> {
        match args.get(index) {
            Some(value) if !is_flag_like(value) => Ok(value.clone()),
            _ => Err(SlidraError::invalid(format!(
                "command {command} missing argument: {arg_name}"
            ))),
        }
    }

    /// Same as `require_positional`, minus the `is_flag_like` check — see
    /// `super::require_id_positional`'s doc for why a presentation id must
    /// accept a `--`-prefixed value.
    pub(super) fn require_id_positional(
        args: &[String],
        index: usize,
        command: &str,
        arg_name: &str,
    ) -> Result<String, SlidraError> {
        match args.get(index) {
            Some(value) => Ok(value.clone()),
            None => Err(SlidraError::invalid(format!(
                "command {command} missing argument: {arg_name}"
            ))),
        }
    }

    /// The value immediately following `flag` in `args`. Errors if `flag`
    /// is absent, or present with no value (or a flag-shaped "value").
    pub(super) fn require_flag(
        args: &[String],
        flag: &str,
        command: &str,
    ) -> Result<String, SlidraError> {
        let index = args.iter().position(|arg| arg == flag).ok_or_else(|| {
            SlidraError::invalid(format!("command {command} missing argument: {flag}"))
        })?;
        match args.get(index + 1) {
            Some(value) if !is_flag_like(value) => Ok(value.clone()),
            _ => Err(SlidraError::invalid(format!("{flag} missing value"))),
        }
    }

    /// Same as `require_flag`, but `Ok(None)` when `flag` is simply absent
    /// (still an error if `flag` is present with no value).
    pub(super) fn optional_flag(
        args: &[String],
        flag: &str,
    ) -> Result<Option<String>, SlidraError> {
        let Some(index) = args.iter().position(|arg| arg == flag) else {
            return Ok(None);
        };
        match args.get(index + 1) {
            Some(value) if !is_flag_like(value) => Ok(Some(value.clone())),
            _ => Err(SlidraError::invalid(format!("{flag} missing value"))),
        }
    }

    /// `require_flag` followed by a `Number(raw)` + `Number.isFinite` check
    /// — see `super::parse_js_number`'s doc for the coercion this
    /// reproduces.
    pub(super) fn require_number_flag(
        args: &[String],
        flag: &str,
        command: &str,
    ) -> Result<f64, SlidraError> {
        let raw = require_flag(args, flag, command)?;
        super::parse_js_number(&raw)
            .filter(|value| value.is_finite())
            .ok_or_else(|| SlidraError::invalid(format!("{flag} is not a valid number: {raw}")))
    }

    /// `optional_flag` followed by the same `Number`/`isFinite` check as
    /// `require_number_flag`; `Ok(None)` when `flag` is absent.
    pub(super) fn optional_number_flag(
        args: &[String],
        flag: &str,
        // Unused, kept to mirror `optionalNumberFlag(args, flag, command)`'s
        // TS signature 1:1 (that parameter is likewise unused in the TS
        // body) so every argv helper here has the same call shape as
        // `require_number_flag`.
        _command: &str,
    ) -> Result<Option<f64>, SlidraError> {
        let Some(raw) = optional_flag(args, flag)? else {
            return Ok(None);
        };
        let value = super::parse_js_number(&raw)
            .filter(|value| value.is_finite())
            .ok_or_else(|| SlidraError::invalid(format!("{flag} is not a valid number: {raw}")))?;
        Ok(Some(value))
    }

    /// A bare boolean flag with no value. Presence anywhere in `args` is
    /// enough — order relative to other flags does not matter.
    pub(super) fn has_flag(args: &[String], flag: &str) -> bool {
        args.iter().any(|arg| arg == flag)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn require_positional_rejects_flag_shaped_value() {
            let args = vec!["--foo".to_string()];
            let err = require_positional(&args, 0, "cmd", "path").unwrap_err();
            assert_eq!(err.message(), "command cmd missing argument: path");
        }

        #[test]
        fn require_id_positional_accepts_a_dash_prefixed_id() {
            let args = vec!["--IXET6Q29_h".to_string()];
            assert_eq!(
                require_id_positional(&args, 0, "table create", "id").unwrap(),
                "--IXET6Q29_h"
            );
        }

        #[test]
        fn require_id_positional_still_rejects_a_missing_positional() {
            let args: Vec<String> = vec![];
            let err = require_id_positional(&args, 0, "table create", "id").unwrap_err();
            assert_eq!(err.message(), "command table create missing argument: id");
        }

        #[test]
        fn require_flag_returns_the_following_value() {
            let args = vec!["--type".to_string(), "bar".to_string()];
            assert_eq!(require_flag(&args, "--type", "cmd").unwrap(), "bar");
        }

        #[test]
        fn require_flag_missing_value_errors() {
            let args = vec!["--type".to_string()];
            let err = require_flag(&args, "--type", "cmd").unwrap_err();
            assert_eq!(err.message(), "--type missing value");
        }

        #[test]
        fn optional_flag_absent_is_none() {
            let args: Vec<String> = vec![];
            assert_eq!(optional_flag(&args, "--type").unwrap(), None);
        }

        #[test]
        fn require_number_flag_rejects_non_finite_result() {
            let args = vec!["--w".to_string(), "not-a-number".to_string()];
            let err = require_number_flag(&args, "--w", "cmd").unwrap_err();
            assert_eq!(err.message(), "--w is not a valid number: not-a-number");
        }
    }
}
