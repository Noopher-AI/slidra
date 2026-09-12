//! `asset import` argv parsing.
//!
//! There was no existing TS `argv.ts` `case "asset"` to port field-for-field
//! from — the grammar below was defined directly for this command (see
//! `docs/spec/cli.md`'s `## \`asset import\`` section, now the sole
//! authority on it since the TypeScript CLI was deleted). This Rust
//! argv module is written directly against that spec section's literal
//! grammar:
//!
//! ```text
//! comotion asset import <presentation-id> <source> [--as <value>]
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
use super::is_flag_like;
use crate::errors::CoMotionError;

#[derive(Debug, PartialEq)]
pub struct AssetImportArgs {
    pub id: String,
    pub source: String,
    /// Raw `--as` value, unvalidated. `None` when the flag was omitted.
    pub as_format: Option<String>,
    /// `--svg` inline markup; `source` is empty when set.
    pub svg: Option<String>,
    /// `--name`, only with `--svg`.
    pub name: Option<String>,
}

/// Parses `asset import <id> <source> [--as <value>]`. `args` is the
/// already-`--json`-stripped `rest` slice AFTER the `import` subcommand
/// token has been consumed by the caller — the same convention
/// `argv::chart`/`argv::table`'s per-subcommand parsers use.
pub fn parse_import(args: &[String]) -> Result<AssetImportArgs, CoMotionError> {
    let id = require_id_positional(args, 0, "asset import", "presentation-id")?;
    let svg = optional_flag(args, "--svg")?;
    let name = optional_flag(args, "--name")?;
    let as_format = optional_flag(args, "--as")?;
    // `--svg` builds the asset from inline markup: no source positional
    // then, and `--name` is required. Both given → refuse.
    let has_source_positional = args.get(1).is_some_and(|a| !is_flag_like(a));
    if svg.is_some() {
        if has_source_positional {
            return Err(CoMotionError::invalid(
                "asset import 的 --svg 與 <source> 不能同時給",
            ));
        }
        if as_format.is_some() {
            return Err(CoMotionError::invalid(
                "asset import 的 --svg 不能與 --as 同時給",
            ));
        }
        let Some(name) = name else {
            return Err(CoMotionError::invalid(
                "asset import --svg 缺少參數：--name",
            ));
        };
        return Ok(AssetImportArgs {
            id,
            source: String::new(),
            as_format: None,
            svg,
            name: Some(name),
        });
    }
    if name.is_some() {
        return Err(CoMotionError::invalid(
            "asset import 的 --name 只能與 --svg 一起用",
        ));
    }
    let source = require_positional(args, 1, "asset import", "source")?;
    Ok(AssetImportArgs {
        id,
        source,
        as_format,
        svg: None,
        name: None,
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
