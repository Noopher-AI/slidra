// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Legacy `.slidra` v1-v4 ZIP container reading — the read-only half this
//! crate still needs once the live container format is SQLite
//! (`deck.rs`). `pack_directory`/`unpack_container` (this file's previous
//! contents, when a `.slidra` was itself a ZIP written and read from a
//! real work directory) are gone: nothing in this crate ever writes a ZIP
//! any more, and nothing ever unpacks one onto a real directory — the sole
//! remaining caller is `deck::migrate_legacy_zip_in_place`, which reads a
//! legacy file's entries into memory (`read_legacy_zip`) and builds a
//! brand-new SQLite deck from them.

use crate::errors::{SlidraError, SlidraResult};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

/// The three directories every deck (legacy or SQLite) guarantees exist,
/// even when empty — mirrored as explicit `kind = 1` rows in a freshly
/// created or migrated SQLite deck (`deck.rs`).
pub const REQUIRED_DIRS: [&str; 3] = ["slides", "assets", "fonts"];

/// Reads every file entry out of a legacy ZIP `.slidra` at `path` into a
/// "relative path -> bytes" map, after validating the same three things
/// `unpack_container` used to validate before trusting a ZIP's content:
/// no path-traversal entry, a structurally valid `project.json` (at any of
/// the pre-SQLite format versions, 1 through 4 — never the crate's current
/// `FORMAT_VERSION`, which is SQLite-only), and no slide SVG still carrying
/// the old CoMotion namespace marker. Directory entries (names ending in
/// `/`) are not included in the returned map — `deck.rs` re-derives
/// directory rows itself (`REQUIRED_DIRS` plus every inserted file's
/// ancestors), so an *empty* legacy directory entry carries no information
/// this function's caller needs to preserve beyond "this deck has the
/// three required directories", which every deck gets unconditionally.
pub fn read_legacy_zip(path: &Path) -> SlidraResult<BTreeMap<String, Vec<u8>>> {
    let display = path.display().to_string();
    let raw = std::fs::read(path).map_err(|_| {
        SlidraError::invalid(format!("failed to read presentation file: {display}"))
    })?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(raw))
        .map_err(|_| SlidraError::invalid(format!("presentation file is corrupted: {display}")))?;

    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| {
            SlidraError::invalid(format!("presentation file is corrupted: {display}"))
        })?;
        let name = entry.name().to_string();
        assert_entry_within_target(&name, &display)?;
        if name.ends_with('/') {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|_| {
            SlidraError::invalid(format!("presentation file is corrupted: {display}"))
        })?;
        files.insert(name, buf);
    }

    validate_legacy_project_json(&files, &display)?;
    assert_no_legacy_comotion_slides(&files, &display)?;
    Ok(files)
}

/// Rejects an archive entry that is absolute or whose name contains a `..`
/// segment — the read-side counterpart of `virtual_fs`'s structural
/// traversal guard, applied here because a ZIP entry name is untrusted
/// input the same way a caller-supplied virtual path is.
fn assert_entry_within_target(entry_path: &str, display: &str) -> SlidraResult<()> {
    if entry_path.starts_with('/') || entry_path.starts_with('\\') {
        return Err(SlidraError::invalid(format!(
            "presentation file contains an invalid path: {display}"
        )));
    }
    for segment in entry_path.split(['/', '\\']) {
        if segment == ".." {
            return Err(SlidraError::invalid(format!(
                "presentation file contains an invalid path: {display}"
            )));
        }
    }
    Ok(())
}

/// Rejects a presentation whose slide SVGs still carry the old CoMotion
/// namespace markers (`xmlns:comot` or `co-motion.dev/ns`) — legacy format
/// version 1 is shared by both the old CoMotion format and the earliest
/// Slidra format, so the version number alone cannot tell them apart.
fn assert_no_legacy_comotion_slides(
    files: &BTreeMap<String, Vec<u8>>,
    display: &str,
) -> SlidraResult<()> {
    for (path, bytes) in files {
        if !path.starts_with("slides/") || !path.ends_with(".svg") {
            continue;
        }
        let Ok(content) = std::str::from_utf8(bytes) else {
            continue;
        };
        if content.contains("xmlns:comot") || content.contains("co-motion.dev/ns") {
            return Err(SlidraError::invalid(format!(
                "this presentation was made by CoMotion and is not supported by Slidra: {display}"
            )));
        }
    }
    Ok(())
}

/// Structural validation of a legacy `project.json`, tolerant of any
/// pre-SQLite format version (1 through 4) — `workspace::project`'s own
/// `validate_project_json_value` is deliberately NOT reused here: it
/// requires `formatVersion == FORMAT_VERSION` (the crate's current, SQLite-
/// only value), which no legacy file will ever carry.
fn validate_legacy_project_json(
    files: &BTreeMap<String, Vec<u8>>,
    display: &str,
) -> SlidraResult<()> {
    let raw = files.get("project.json").ok_or_else(|| {
        SlidraError::invalid(format!("presentation file missing project.json: {display}"))
    })?;
    let parsed: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|_| SlidraError::invalid(format!("project.json is not valid JSON: {display}")))?;
    // Field-specific messages below deliberately match
    // `workspace::project::validate_project_json`'s own wording exactly
    // (never including `display` — ADR-0003: these are content-structure
    // errors, not filesystem errors) — the one difference is the
    // `formatVersion` check itself, tolerant of every pre-SQLite value
    // (1 through 4) rather than requiring the crate's current version.
    let obj = parsed.as_object().ok_or_else(|| {
        SlidraError::invalid("project.json format error: content is not an object")
    })?;
    let version_ok = matches!(
        obj.get("formatVersion"),
        Some(serde_json::Value::Number(n)) if matches!(n.as_u64(), Some(1..=4))
    );
    if !version_ok {
        return Err(SlidraError::invalid(
            "project.json format error: formatVersion must be between 1 and 4",
        ));
    }
    if !matches!(obj.get("name"), Some(serde_json::Value::String(_))) {
        return Err(SlidraError::invalid(
            "project.json format error: missing or wrong type for name",
        ));
    }
    let canvas_ok = matches!(
        obj.get("canvas"),
        Some(serde_json::Value::Object(c))
            if matches!(c.get("width"), Some(serde_json::Value::Number(_)))
                && matches!(c.get("height"), Some(serde_json::Value::Number(_)))
    );
    if !canvas_ok {
        return Err(SlidraError::invalid(
            "project.json format error: missing or wrong type for canvas",
        ));
    }
    let slides = match obj.get("slides") {
        Some(serde_json::Value::Array(arr)) => arr,
        _ => {
            return Err(SlidraError::invalid(
                "project.json format error: slides is not an array",
            ));
        }
    };
    if !slides.iter().all(serde_json::Value::is_string) {
        return Err(SlidraError::invalid(
            "project.json format error: slides contains an invalid item",
        ));
    }
    Ok(())
}

/// Test-only legacy-ZIP fixture builder, shared with `commands::open`'s and
/// `deck`'s own tests (anything that needs a v1-v4 `.slidra` file to open
/// or migrate).
#[cfg(test)]
pub(crate) fn write_legacy_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut buffer: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut writer, bytes).unwrap();
        }
        writer.finish().unwrap();
    }
    std::fs::write(path, &buffer).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-container-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn minimal_project_json_v1() -> &'static [u8] {
        br#"{"formatVersion":1,"name":"T","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"fonts":[]}"#
    }

    #[test]
    fn reads_every_file_entry_into_a_map() {
        let dir = temp_dir("read-entries");
        let path = dir.join("legacy.slidra");
        write_legacy_zip(
            &path,
            &[
                ("project.json", minimal_project_json_v1()),
                ("slides/001.svg", b"<svg/>"),
            ],
        );

        let files = read_legacy_zip(&path).unwrap();
        assert_eq!(files.get("slides/001.svg").unwrap(), b"<svg/>");
        assert!(files.contains_key("project.json"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_comotion_slide() {
        let dir = temp_dir("comotion");
        let path = dir.join("legacy.slidra");
        write_legacy_zip(
            &path,
            &[
                ("project.json", minimal_project_json_v1()),
                (
                    "slides/001.svg",
                    br#"<svg xmlns:comot="https://co-motion.dev/ns"></svg>"#,
                ),
            ],
        );

        let err = read_legacy_zip(&path).unwrap_err();
        assert!(
            err.message()
                .contains("this presentation was made by CoMotion")
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_path_traversal_entry() {
        let dir = temp_dir("traversal");
        let path = dir.join("legacy.slidra");
        write_legacy_zip(&path, &[("../evil.txt", b"pwned")]);

        let err = read_legacy_zip(&path).unwrap_err();
        assert!(err.message().contains("invalid path"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_missing_project_json() {
        let dir = temp_dir("missing-project-json");
        let path = dir.join("legacy.slidra");
        write_legacy_zip(&path, &[("slides/001.svg", b"<svg/>")]);

        let err = read_legacy_zip(&path).unwrap_err();
        assert!(err.message().contains("missing project.json"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn accepts_every_pre_sqlite_format_version() {
        for version in 1..=4u64 {
            let dir = temp_dir(&format!("version-{version}"));
            let path = dir.join("legacy.slidra");
            let json = format!(
                r#"{{"formatVersion":{version},"name":"T","canvas":{{"width":1,"height":1}},"slides":[]}}"#
            );
            write_legacy_zip(&path, &[("project.json", json.as_bytes())]);
            read_legacy_zip(&path).unwrap();
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
