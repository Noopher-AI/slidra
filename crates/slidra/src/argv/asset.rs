// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

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
//! slidra asset import <presentation-id> <source> [--as <value>]
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
//! "unknown subcommand: asset <x>") is one level above this module, in
//! `main.rs`'s dispatch — out of this file's and this ticket's scope
//! (orchestrator-owned).

use super::ct::{optional_flag, require_id_positional, require_positional};
use super::is_flag_like;
use crate::errors::SlidraError;

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
pub fn parse_import(args: &[String]) -> Result<AssetImportArgs, SlidraError> {
    let id = require_id_positional(args, 0, "asset import", "presentation-id")?;
    let svg = optional_flag(args, "--svg")?;
    let name = optional_flag(args, "--name")?;
    let as_format = optional_flag(args, "--as")?;
    // `--svg` builds the asset from inline markup: no source positional
    // then, and `--name` is required. Both given → refuse.
    let has_source_positional = args.get(1).is_some_and(|a| !is_flag_like(a));
    if svg.is_some() {
        if has_source_positional {
            return Err(SlidraError::invalid(
                "asset import's --svg and <source> cannot be given together",
            ));
        }
        if as_format.is_some() {
            return Err(SlidraError::invalid(
                "asset import's --svg cannot be given together with --as",
            ));
        }
        let Some(name) = name else {
            return Err(SlidraError::invalid(
                "asset import --svg missing argument: --name",
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
        return Err(SlidraError::invalid(
            "asset import's --name can only be used with --svg",
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
        assert_eq!(
            err.message(),
            "command asset import missing argument: source"
        );
    }

    #[test]
    fn missing_id_positional_errors() {
        let args: Vec<String> = vec![];
        let err = parse_import(&args).unwrap_err();
        assert_eq!(
            err.message(),
            "command asset import missing argument: presentation-id"
        );
    }

    #[test]
    fn as_flag_present_with_no_value_errors() {
        let args = vec![
            "pres-1".to_string(),
            "./sales.csv".to_string(),
            "--as".to_string(),
        ];
        let err = parse_import(&args).unwrap_err();
        assert_eq!(err.message(), "--as missing value");
    }
}
