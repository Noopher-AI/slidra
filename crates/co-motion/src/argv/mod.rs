//! Shared argv-parsing primitives for the `chart`/`table`/`asset` command
//! families, ported from `packages/cli/src/argv.ts`'s private helpers
//! (`requirePositional`/`isFlagLike`/`requireFlag`/`optionalFlag`/
//! `requireNumberFlag`/`optionalNumberFlag`/`hasFlag`/`collectRepeatedFlag`,
//! lines 998-1152). Every command-family argv module (`argv::chart`,
//! `argv::table`, `argv::asset`) is built on these instead of each
//! reinventing flag scanning — matching the TS original's one-file-many-
//! `case`-arms shape being backed by one shared set of helpers.
//!
//! Every function here takes the already-`--json`-stripped `rest` slice
//! `main.rs`'s `dispatch_takeover` hands a takeover-table command (the same
//! slice `commands::undo::run`/`commands::redo::run` already receive) — not
//! a pre-split "positionals vs flags" structure, exactly mirroring how the
//! TS `rest: string[]` is scanned by index and by `indexOf` in place.

pub mod asset;
pub mod chart;
pub mod table;

use crate::errors::CoMotionError;

/// A flag-shaped token: starts with `--`. A value in a positional or
/// flag-value slot that looks like this means the actual value was
/// omitted — e.g. `chart create <id> <path> --palette --grid` must not
/// silently take `--grid` as `--palette`'s value.
pub fn is_flag_like(value: &str) -> bool {
    value.starts_with("--")
}

/// The positional argument at `index`, or a "缺少參數" error naming
/// `arg_name`. A flag-shaped value in this slot is treated the same as a
/// missing one (see `is_flag_like`'s doc).
pub fn require_positional(
    args: &[String],
    index: usize,
    command: &str,
    arg_name: &str,
) -> Result<String, CoMotionError> {
    match args.get(index) {
        Some(value) if !is_flag_like(value) => Ok(value.clone()),
        _ => Err(CoMotionError::invalid(format!(
            "命令 {command} 缺少參數：{arg_name}"
        ))),
    }
}

/// The value immediately following `flag` in `args`. Errors if `flag` is
/// absent, or present with no value (or a flag-shaped "value").
pub fn require_flag(args: &[String], flag: &str, command: &str) -> Result<String, CoMotionError> {
    let index = args
        .iter()
        .position(|arg| arg == flag)
        .ok_or_else(|| CoMotionError::invalid(format!("命令 {command} 缺少參數：{flag}")))?;
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(value.clone()),
        _ => Err(CoMotionError::invalid(format!("{flag} 缺少值"))),
    }
}

/// Same as `require_flag`, but `Ok(None)` when `flag` is simply absent
/// (still an error if `flag` is present with no value).
pub fn optional_flag(args: &[String], flag: &str) -> Result<Option<String>, CoMotionError> {
    let Some(index) = args.iter().position(|arg| arg == flag) else {
        return Ok(None);
    };
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(Some(value.clone())),
        _ => Err(CoMotionError::invalid(format!("{flag} 缺少值"))),
    }
}

/// `require_flag` followed by a `Number(raw)` + `Number.isFinite` check —
/// see `parse_js_number`'s doc for the coercion this reproduces.
pub fn require_number_flag(
    args: &[String],
    flag: &str,
    command: &str,
) -> Result<f64, CoMotionError> {
    let raw = require_flag(args, flag, command)?;
    parse_js_number(&raw)
        .filter(|value| value.is_finite())
        .ok_or_else(|| CoMotionError::invalid(format!("{flag} 不是合法數字：{raw}")))
}

/// `optional_flag` followed by the same `Number`/`isFinite` check as
/// `require_number_flag`; `Ok(None)` when `flag` is absent.
pub fn optional_number_flag(
    args: &[String],
    flag: &str,
    // Unused, kept to mirror `optionalNumberFlag(args, flag, command)`'s TS
    // signature 1:1 (that parameter is likewise unused in the TS body) so
    // every argv helper here has the same call shape as `require_number_flag`.
    _command: &str,
) -> Result<Option<f64>, CoMotionError> {
    let Some(raw) = optional_flag(args, flag)? else {
        return Ok(None);
    };
    let value = parse_js_number(&raw)
        .filter(|value| value.is_finite())
        .ok_or_else(|| CoMotionError::invalid(format!("{flag} 不是合法數字：{raw}")))?;
    Ok(Some(value))
}

/// A bare boolean flag with no value. Presence anywhere in `args` is
/// enough — order relative to other flags does not matter.
pub fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

/// Every value following a (possibly repeated) `flag` in `args` —
/// `chart data set --series`/`chart palette set --color`/
/// `chart axis set --right`.
pub fn collect_repeated_flag(args: &[String], flag: &str) -> Result<Vec<String>, CoMotionError> {
    let mut values = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            match args.get(i + 1) {
                Some(value) if !is_flag_like(value) => {
                    values.push(value.clone());
                    i += 1;
                }
                _ => return Err(CoMotionError::invalid(format!("{flag} 缺少值"))),
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
    fn require_positional_rejects_flag_shaped_value() {
        let args = vec!["--foo".to_string()];
        let err = require_positional(&args, 0, "cmd", "path").unwrap_err();
        assert_eq!(err.message(), "命令 cmd 缺少參數：path");
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
        assert_eq!(err.message(), "--type 缺少值");
    }

    #[test]
    fn optional_flag_absent_is_none() {
        let args: Vec<String> = vec![];
        assert_eq!(optional_flag(&args, "--type").unwrap(), None);
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
    fn require_number_flag_rejects_non_finite_result() {
        let args = vec!["--w".to_string(), "not-a-number".to_string()];
        let err = require_number_flag(&args, "--w", "cmd").unwrap_err();
        assert_eq!(err.message(), "--w 不是合法數字：not-a-number");
    }
}
