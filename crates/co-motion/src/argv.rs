//! Shared argv parsing helpers for the command handlers in `commands/`,
//! ported from `packages/cli/src/argv.ts`'s small-function toolkit
//! (`requirePositional`/`isFlagLike`/`requireFlag`/`optionalFlag`/
//! `requireNumberFlag`/`hasFlag`). Every function here returns a plain
//! `String` error message on failure — callers wrap it into a
//! `CommandResult::failure` themselves (argv errors are reported the same
//! way as any other command failure, `FailureKind::Failed`, never a
//! separate exit path).

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
        _ => Err(format!("命令 {command} 缺少參數：{arg_name}")),
    }
}

/// The value following `flag` in `args`, or an error when the flag is
/// absent or has no legal value.
pub fn require_flag(args: &[String], flag: &str, command: &str) -> Result<String, String> {
    let Some(index) = args.iter().position(|a| a == flag) else {
        return Err(format!("命令 {command} 缺少參數：{flag}"));
    };
    match args.get(index + 1) {
        Some(value) if !is_flag_like(value) => Ok(value.clone()),
        _ => Err(format!("{flag} 缺少值")),
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
        _ => Err(format!("{flag} 缺少值")),
    }
}

pub fn require_number_flag(args: &[String], flag: &str, command: &str) -> Result<f64, String> {
    let raw = require_flag(args, flag, command)?;
    raw.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("{flag} 不是合法數字：{raw}"))
}

pub fn optional_number_flag(args: &[String], flag: &str) -> Result<Option<f64>, String> {
    let Some(raw) = optional_flag(args, flag)? else {
        return Ok(None);
    };
    raw.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .map(Some)
        .ok_or_else(|| format!("{flag} 不是合法數字：{raw}"))
}

/// A bare boolean flag with no value (`--force`, `--all`). Presence
/// anywhere in `args` is enough.
pub fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
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
            "命令 cmd 缺少參數：path"
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
    fn require_flag_finds_value_after_flag() {
        let args = vec!["--width".to_string(), "100".to_string()];
        assert_eq!(require_flag(&args, "--width", "cmd").unwrap(), "100");
    }

    #[test]
    fn require_flag_missing_value_errors() {
        let args = vec!["--width".to_string()];
        assert_eq!(
            require_flag(&args, "--width", "cmd").unwrap_err(),
            "--width 缺少值"
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
            "--width 不是合法數字：abc"
        );
    }

    #[test]
    fn has_flag_detects_presence_anywhere() {
        let args = vec!["a".to_string(), "--force".to_string(), "b".to_string()];
        assert!(has_flag(&args, "--force"));
        assert!(!has_flag(&args, "--other"));
    }
}
