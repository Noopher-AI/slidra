//! `asset import`'s pure decisions (format detection dispatch, filename
//! sanitization/conflict resolution). No I/O here: reading the source (a
//! local path or a URL) and writing the result into `assets/`/`assets/data/`
//! is `commands::asset_import::run`'s job.
//!
//! Public API:
//! - `sanitize_asset_base_name(source_name) -> String`
//! - `resolve_conflict_free_filename(base_name, extension, existing_names) -> String`
//! - `resolve_asset_import(input) -> SlidraResult<ResolvedAssetImport>` — the
//!   media-asset path (no `--as`).
//! - `resolve_data_asset_import(input) -> SlidraResult<ResolvedDataAssetImport>`
//!   — the `--as csv` path (ADR-0015's deliberate, explicit hole).

use crate::errors::{SlidraError, SlidraResult};
use crate::media_format::{MediaFormatEntry, detect_media_format};
use crate::table::csv::parse_table_csv;
use std::collections::HashSet;

/// Strips the extension off a source filename (mirrors TS's
/// `/\.[^./]+$/`: a trailing dot followed by one or more characters that
/// are themselves neither `.` nor `/`). `rfind('.')` finds the LAST dot in
/// the string, so by construction nothing after it can contain another
/// `.`; the explicit `contains('.')` check below is kept anyway as a
/// direct, readable mirror of the TS regex's own character class rather
/// than relying on that invariant silently.
fn strip_extension(source_name: &str) -> &str {
    if let Some(dot_index) = source_name.rfind('.') {
        let after = &source_name[dot_index + 1..];
        if !after.is_empty() && !after.contains('.') && !after.contains('/') {
            return &source_name[..dot_index];
        }
    }
    source_name
}

/// Mirrors TS's `ILLEGAL_FILESYSTEM_CHARS = /[\\/:*?"<>|\x00-\x1f]/g`.
fn is_illegal_filesystem_char(c: char) -> bool {
    matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) <= 0x1f
}

fn replace_illegal_filesystem_chars(s: &str) -> String {
    s.chars()
        .map(|c| {
            if is_illegal_filesystem_char(c) {
                '_'
            } else {
                c
            }
        })
        .collect()
}

/// Strips the extension off a source filename and replaces characters an
/// on-disk filename cannot contain with `_`. Falls back to `"asset"` only
/// when the source name yields nothing usable at all (e.g. a URL with no
/// path segment) — not a fallback for a rejected format, just a name.
pub fn sanitize_asset_base_name(source_name: &str) -> String {
    let without_extension = strip_extension(source_name);
    let sanitized = replace_illegal_filesystem_chars(without_extension);
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "asset".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Resolves a conflict-free filename under `assets/`: `<baseName><extension>`
/// if free, otherwise `<baseName>-1<extension>`, `<baseName>-2<extension>`,
/// … up to the first name not already in `existing_names`. Never
/// overwrites, never uses a timestamp.
pub fn resolve_conflict_free_filename(
    base_name: &str,
    extension: &str,
    existing_names: &[String],
) -> String {
    let existing: HashSet<&str> = existing_names.iter().map(String::as_str).collect();
    let candidate = format!("{base_name}{extension}");
    if !existing.contains(candidate.as_str()) {
        return candidate;
    }
    let mut suffix: u64 = 1;
    loop {
        let candidate = format!("{base_name}-{suffix}{extension}");
        if !existing.contains(candidate.as_str()) {
            return candidate;
        }
        suffix += 1;
    }
}

pub struct ResolveAssetImportInput<'a> {
    /// The source's filename or URL path segment, used only to derive the
    /// imported file's base name — never to decide its format.
    pub source_name: &'a str,
    pub bytes: &'a [u8],
    /// Current entries of the presentation's `assets/` directory.
    pub existing_asset_names: &'a [String],
}

#[derive(Debug, PartialEq)]
pub struct ResolvedAssetImport {
    pub format: MediaFormatEntry,
    /// The conflict-free filename to write under `assets/`.
    pub file_name: String,
}

/// Decides an asset import's outcome: detects the real format from the
/// bytes (never the source's claimed extension), then resolves a
/// conflict-free destination filename. Errors when the bytes match no
/// known media format — the only rejection this function raises, and the
/// only one asset import raises for "wrong content" (ADR-0015: no fallback
/// to octet-stream, no guessing from the extension).
pub fn resolve_asset_import(input: ResolveAssetImportInput) -> SlidraResult<ResolvedAssetImport> {
    let format = detect_media_format(input.bytes).ok_or_else(|| {
        SlidraError::invalid("unsupported media format: file content is not a recognized image, video or audio format")
    })?;
    let base_name = sanitize_asset_base_name(input.source_name);
    let file_name =
        resolve_conflict_free_filename(&base_name, format.extension, input.existing_asset_names);
    Ok(ResolvedAssetImport { format, file_name })
}

// ---------------------------------------------------------------------------
// `asset import --as csv`: a deliberate, explicit hole in ADR-0015's "no
// text files, ever" guard. Without `--as csv`, `resolve_asset_import` above
// is untouched byte-for-byte — this path only runs when the caller opts in.
// ---------------------------------------------------------------------------

const RESERVED_CSV_HEADER_NAMES: [&str; 3] = ["slide_number", "slide_total", "presentation_name"];

/// Mirrors TS's `ILLEGAL_CSV_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/`
/// — NUL and every C0 control code except `\t` (0x09), `\n` (0x0A) and
/// `\r` (0x0D). CSV is data, not markup, but it is still text.
fn contains_illegal_csv_control_char(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c as u32, 0x00..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F))
}

pub struct ResolveDataAssetImportInput<'a> {
    /// The source's filename or URL path segment — must end in `.csv`
    /// (case-insensitive), never sniffed from content.
    pub source_name: &'a str,
    pub bytes: &'a [u8],
    /// Current entries of the presentation's `assets/data/` directory.
    pub existing_asset_names: &'a [String],
}

#[derive(Debug, PartialEq)]
pub struct ResolvedDataAssetImport {
    /// The conflict-free filename to write under `assets/data/`.
    pub file_name: String,
}

/// Decides a data-asset import's outcome (`--as csv`): the source name
/// must end in `.csv`, the bytes must decode as UTF-8 text free of stray
/// control characters, and the text must parse as a legal table CSV (RFC
/// 4180, non-empty unique header names, consistent column counts —
/// `table::csv::parse_table_csv` already enforces all of that) whose
/// header does not collide with a `{{ }}` dynamic-text reserved name.
/// Nothing is ever written when this errors.
pub fn resolve_data_asset_import(
    input: ResolveDataAssetImportInput,
) -> SlidraResult<ResolvedDataAssetImport> {
    if !input.source_name.to_ascii_lowercase().ends_with(".csv") {
        return Err(SlidraError::invalid(format!(
            "data asset must be a .csv file: {}",
            input.source_name
        )));
    }

    let text = std::str::from_utf8(input.bytes)
        .map_err(|_| SlidraError::invalid("CSV content is not valid UTF-8 text"))?;
    if contains_illegal_csv_control_char(text) {
        return Err(SlidraError::invalid("CSV content is not valid UTF-8 text"));
    }

    let parsed = parse_table_csv(text)?;
    for header in &parsed.headers {
        if RESERVED_CSV_HEADER_NAMES.contains(&header.as_str()) {
            return Err(SlidraError::invalid(format!(
                "CSV header cannot use reserved name (conflicts with dynamic text variable): {header}"
            )));
        }
    }

    let base_name = sanitize_asset_base_name(input.source_name);
    let file_name = resolve_conflict_free_filename(&base_name, ".csv", input.existing_asset_names);
    Ok(ResolvedDataAssetImport { file_name })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- sanitize_asset_base_name --------------------------------------

    #[test]
    fn strips_extension_and_keeps_plain_name() {
        assert_eq!(sanitize_asset_base_name("photo.png"), "photo");
    }

    #[test]
    fn replaces_illegal_filesystem_characters_with_underscore() {
        assert_eq!(
            sanitize_asset_base_name("weird:name?/with*bad<chars>.png"),
            "weird_name__with_bad_chars_"
        );
    }

    #[test]
    fn replaces_control_characters_with_underscore() {
        assert_eq!(sanitize_asset_base_name("a\u{0001}b.png"), "a_b");
    }

    #[test]
    fn empty_after_sanitizing_falls_back_to_asset() {
        // A URL with no path segment sanitizes (after extension-stripping
        // and illegal-char replacement) down to nothing usable.
        assert_eq!(sanitize_asset_base_name(""), "asset");
        assert_eq!(sanitize_asset_base_name(".png"), "asset");
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(sanitize_asset_base_name("  photo  .png"), "photo");
    }

    // -- resolve_conflict_free_filename ----------------------------------

    #[test]
    fn no_conflict_uses_bare_name() {
        let existing: Vec<String> = vec![];
        assert_eq!(
            resolve_conflict_free_filename("photo", ".png", &existing),
            "photo.png"
        );
    }

    #[test]
    fn one_conflict_gets_dash_one_suffix() {
        let existing = vec!["photo.png".to_string()];
        assert_eq!(
            resolve_conflict_free_filename("photo", ".png", &existing),
            "photo-1.png"
        );
    }

    #[test]
    fn multiple_conflicts_finds_first_free_slot() {
        let existing = vec![
            "photo.png".to_string(),
            "photo-1.png".to_string(),
            "photo-2.png".to_string(),
        ];
        assert_eq!(
            resolve_conflict_free_filename("photo", ".png", &existing),
            "photo-3.png"
        );
    }

    #[test]
    fn never_overwrites_even_with_a_gap_in_the_sequence() {
        // photo-2.png is free, but the rule is "first free slot scanning
        // upward from 1", not "any free slot" — must not skip to the gap.
        let existing = vec!["photo.png".to_string(), "photo-1.png".to_string()];
        assert_eq!(
            resolve_conflict_free_filename("photo", ".png", &existing),
            "photo-2.png"
        );
    }

    // -- resolve_asset_import ---------------------------------------------

    const PNG_BYTES: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const JPEG_BYTES: [u8; 4] = [0xff, 0xd8, 0xff, 0xe0];

    #[test]
    fn unknown_bytes_are_rejected() {
        let existing: Vec<String> = vec![];
        let err = resolve_asset_import(ResolveAssetImportInput {
            source_name: "mystery.bin",
            bytes: b"not a media file",
            existing_asset_names: &existing,
        })
        .unwrap_err();
        assert_eq!(
            err.message(),
            "unsupported media format: file content is not a recognized image, video or audio format"
        );
    }

    #[test]
    fn extension_lies_byte_header_wins() {
        // Source name claims .png, but the bytes are a JPEG header — the
        // imported file must be named with a .jpg extension, trusting the
        // byte header, never the caller-supplied extension (ADR-0015).
        let existing: Vec<String> = vec![];
        let resolved = resolve_asset_import(ResolveAssetImportInput {
            source_name: "photo.png",
            bytes: &JPEG_BYTES,
            existing_asset_names: &existing,
        })
        .unwrap();
        assert_eq!(resolved.file_name, "photo.jpg");
        assert_eq!(resolved.format.mime_type, "image/jpeg");
    }

    #[test]
    fn recognised_bytes_resolve_a_conflict_free_name() {
        let existing = vec!["photo.png".to_string()];
        let resolved = resolve_asset_import(ResolveAssetImportInput {
            source_name: "photo.png",
            bytes: &PNG_BYTES,
            existing_asset_names: &existing,
        })
        .unwrap();
        assert_eq!(resolved.file_name, "photo-1.png");
    }

    // -- resolve_data_asset_import ------------------------------------

    #[test]
    fn non_csv_source_name_is_rejected() {
        let existing: Vec<String> = vec![];
        let err = resolve_data_asset_import(ResolveDataAssetImportInput {
            source_name: "sales.txt",
            bytes: b"a,b\n1,2\n",
            existing_asset_names: &existing,
        })
        .unwrap_err();
        assert_eq!(err.message(), "data asset must be a .csv file: sales.txt");
    }

    #[test]
    fn csv_extension_is_case_insensitive() {
        let existing: Vec<String> = vec![];
        let resolved = resolve_data_asset_import(ResolveDataAssetImportInput {
            source_name: "sales.CSV",
            bytes: b"name,value\na,1\n",
            existing_asset_names: &existing,
        })
        .unwrap();
        assert_eq!(resolved.file_name, "sales.csv");
    }

    #[test]
    fn invalid_utf8_bytes_are_rejected() {
        let existing: Vec<String> = vec![];
        let invalid_utf8: [u8; 4] = [b'a', b',', 0xff, 0xfe];
        let err = resolve_data_asset_import(ResolveDataAssetImportInput {
            source_name: "sales.csv",
            bytes: &invalid_utf8,
            existing_asset_names: &existing,
        })
        .unwrap_err();
        assert_eq!(err.message(), "CSV content is not valid UTF-8 text");
    }

    #[test]
    fn embedded_nul_byte_is_rejected() {
        let existing: Vec<String> = vec![];
        let bytes = b"name,value\na\0,1\n";
        let err = resolve_data_asset_import(ResolveDataAssetImportInput {
            source_name: "sales.csv",
            bytes,
            existing_asset_names: &existing,
        })
        .unwrap_err();
        assert_eq!(err.message(), "CSV content is not valid UTF-8 text");
    }

    #[test]
    fn stray_c0_control_char_is_rejected_but_tab_newline_cr_are_allowed() {
        let existing: Vec<String> = vec![];
        // \x0B (vertical tab) is a C0 control char NOT in the allow-list.
        let bytes = "name,value\na\u{000B}b,1\n".as_bytes();
        let err = resolve_data_asset_import(ResolveDataAssetImportInput {
            source_name: "sales.csv",
            bytes,
            existing_asset_names: &existing,
        })
        .unwrap_err();
        assert_eq!(err.message(), "CSV content is not valid UTF-8 text");
    }

    #[test]
    fn reserved_header_name_is_rejected() {
        let existing: Vec<String> = vec![];
        let bytes = b"slide_number,value\n1,2\n";
        let err = resolve_data_asset_import(ResolveDataAssetImportInput {
            source_name: "sales.csv",
            bytes,
            existing_asset_names: &existing,
        })
        .unwrap_err();
        assert_eq!(
            err.message(),
            "CSV header cannot use reserved name (conflicts with dynamic text variable): slide_number"
        );
    }

    #[test]
    fn valid_csv_resolves_a_conflict_free_dot_csv_filename() {
        let existing = vec!["sales.csv".to_string()];
        let resolved = resolve_data_asset_import(ResolveDataAssetImportInput {
            source_name: "sales.csv",
            bytes: b"name,value\na,1\nb,2\n",
            existing_asset_names: &existing,
        })
        .unwrap();
        assert_eq!(resolved.file_name, "sales-1.csv");
    }
}
