//! `asset import` argv parsing.
//!
//! There is no existing TS `argv.ts` `case "asset"` to port field-for-field
//! from — that case is itself this ticket's one TypeScript change (see
//! `docs/spec/cli.md`'s "並存期已知限制" note under `## \`asset import\``).
//! This Rust argv module is written directly against that spec section's
//! literal grammar:
//!
//! ```text
//! co-motion asset import <presentation-id> <source> [--as <value>]
//! ```
//!
//! Positional 0 is the presentation id, positional 1 is the source (a
//! local filesystem path or an `http(s)://` URL). An optional `--as` flag
//! carries its raw string value through UNVALIDATED — whether that value
//! is legal (currently only `"csv"`) is `commands::asset_import::run`'s
//! job, mirroring how `packages/cli/src/commands/asset-import.ts`'s
//! `assetImportCommand` (not `argv.ts`) is the one that rejects an
//! unsupported `--as` value; `argv.ts`'s new `case "asset"` likewise just
//! extracts `{ id, source, as }` without validating `as`.
//!
//! Dispatching `rest[0] === "import"` vs. any other subcommand (TS's
//! "未知的子命令：asset <x>") is one level above this module, in
//! `main.rs`'s dispatch — out of this file's and this ticket's scope
//! (orchestrator-owned).

use super::ct::{optional_flag, require_id_positional, require_positional};
use crate::errors::CoMotionError;

#[derive(Debug, PartialEq)]
pub struct AssetImportArgs {
    pub id: String,
    pub source: String,
    /// Raw `--as` value, unvalidated. `None` when the flag was omitted.
    pub as_format: Option<String>,
}

/// Parses `asset import <id> <source> [--as <value>]`. `args` is the
/// already-`--json`-stripped `rest` slice AFTER the `import` subcommand
/// token has been consumed by the caller — the same convention
/// `argv::chart`/`argv::table`'s per-subcommand parsers use.
pub fn parse_import(args: &[String]) -> Result<AssetImportArgs, CoMotionError> {
    let id = require_id_positional(args, 0, "asset import", "presentation-id")?;
    let source = require_positional(args, 1, "asset import", "source")?;
    let as_format = optional_flag(args, "--as")?;
    Ok(AssetImportArgs {
        id,
        source,
        as_format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_id_and_source_without_as_flag() {
        let args = vec!["pres-1".to_string(), "/tmp/photo.png".to_string()];
        let parsed = parse_import(&args).unwrap();
        assert_eq!(parsed.id, "pres-1");
        assert_eq!(parsed.source, "/tmp/photo.png");
        assert_eq!(parsed.as_format, None);
    }

    #[test]
    fn parses_as_flag_value() {
        let args = vec![
            "pres-1".to_string(),
            "./sales.csv".to_string(),
            "--as".to_string(),
            "csv".to_string(),
        ];
        let parsed = parse_import(&args).unwrap();
        assert_eq!(parsed.as_format.as_deref(), Some("csv"));
    }

    #[test]
    fn as_flag_value_passes_through_unvalidated() {
        // Whether "yaml" is a legal --as value is the command handler's
        // decision, not this parser's — see module doc.
        let args = vec![
            "pres-1".to_string(),
            "./sales.csv".to_string(),
            "--as".to_string(),
            "yaml".to_string(),
        ];
        let parsed = parse_import(&args).unwrap();
        assert_eq!(parsed.as_format.as_deref(), Some("yaml"));
    }

    #[test]
    fn missing_source_positional_errors() {
        let args = vec!["pres-1".to_string()];
        let err = parse_import(&args).unwrap_err();
        assert_eq!(err.message(), "命令 asset import 缺少參數：source");
    }

    #[test]
    fn missing_id_positional_errors() {
        let args: Vec<String> = vec![];
        let err = parse_import(&args).unwrap_err();
        assert_eq!(err.message(), "命令 asset import 缺少參數：presentation-id");
    }

    #[test]
    fn as_flag_present_with_no_value_errors() {
        let args = vec![
            "pres-1".to_string(),
            "./sales.csv".to_string(),
            "--as".to_string(),
        ];
        let err = parse_import(&args).unwrap_err();
        assert_eq!(err.message(), "--as 缺少值");
    }
}
