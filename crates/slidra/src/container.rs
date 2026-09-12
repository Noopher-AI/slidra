// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

//! `.slidra` zip container read/write, using the `zip`/`flate2`
//! crates in place of `fflate` (§3.6/D2 of the plan — version pinned to
//! `zip = "7.2.0"`, the newest release this workspace's `rust-toolchain.toml`
//! 1.85.0 can build). The `.slidra` zip's own bytes are never required to
//! match the TS `fflate` output (slidra-format.md: compression level is not
//! part of the format) — only the decompressed "relative path -> bytes"
//! mapping has to agree (see A2's "equivalence" definition, plan §5).

use crate::errors::{SlidraError, SlidraResult};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const REQUIRED_DIRS: [&str; 3] = ["slides", "assets", "fonts"];

/// Recursively zips every file under `source_dir` into a `.slidra` container
/// at `output_path`. `slides/`, `assets/`, and `fonts/` are guaranteed to
/// exist as entries even when empty.
pub fn pack_directory(source_dir: &Path, output_path: &Path) -> SlidraResult<()> {
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    collect_files(source_dir, source_dir, &mut files)
        // source_dir is either a private staging directory or the hidden
        // work directory (ADR-0004) — never quote it.
        .map_err(|_| SlidraError::invalid("error reading presentation content"))?;

    let mut has_dir_entry: BTreeMap<&str, bool> =
        REQUIRED_DIRS.iter().map(|&d| (d, false)).collect();
    for key in files.keys() {
        for &dir in REQUIRED_DIRS.iter() {
            let prefix = format!("{dir}/");
            if key.as_str() == prefix || key.starts_with(&prefix) {
                has_dir_entry.insert(dir, true);
            }
        }
    }

    let mut buffer: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
        let file_options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let dir_options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);

        for &dir in REQUIRED_DIRS.iter() {
            if !has_dir_entry.get(dir).copied().unwrap_or(false) {
                writer
                    .add_directory(format!("{dir}/"), dir_options)
                    .map_err(|_| {
                        SlidraError::invalid(format!(
                            "failed to write presentation file: {}",
                            output_path.display()
                        ))
                    })?;
            }
        }
        for (path, content) in &files {
            writer.start_file(path, file_options).map_err(|_| {
                SlidraError::invalid(format!(
                    "failed to write presentation file: {}",
                    output_path.display()
                ))
            })?;
            writer.write_all(content).map_err(|_| {
                SlidraError::invalid(format!(
                    "failed to write presentation file: {}",
                    output_path.display()
                ))
            })?;
        }
        writer.finish().map_err(|_| {
            SlidraError::invalid(format!(
                "failed to write presentation file: {}",
                output_path.display()
            ))
        })?;
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| {
            SlidraError::invalid(format!(
                "failed to write presentation file: {}",
                output_path.display()
            ))
        })?;
    }
    std::fs::write(output_path, &buffer).map_err(|_| {
        SlidraError::invalid(format!(
            "failed to write presentation file: {}",
            output_path.display()
        ))
    })?;
    Ok(())
}

fn collect_files(
    root: &Path,
    current_dir: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current_dir)? {
        let entry = entry?;
        let full_path = entry.path();
        let file_type = entry.file_type()?;
        if entry.file_name() == crate::workspace::lock::LOCK_FILE_NAME {
            // The CLI's per-presentation lock lives in the work directory
            // while a command runs (`pack` itself holds it) — never packed.
            continue;
        }
        if file_type.is_dir() {
            collect_files(root, &full_path, files)?;
        } else if file_type.is_file() {
            let relative = full_path
                .strip_prefix(root)
                .expect("full_path is always under root")
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(relative, std::fs::read(&full_path)?);
        }
    }
    Ok(())
}

/// Unzips a `.slidra` container into `target_dir`. Validates that the
/// container has a readable, structurally valid `project.json` at
/// `FORMAT_VERSION` and that no slide SVG carries an old CoMotion namespace
/// marker before trusting it — there is no migration to run afterwards.
pub fn unpack_container(slidra_path: &Path, target_dir: &Path) -> SlidraResult<()> {
    let slidra_display = slidra_path.display().to_string();
    let metadata = std::fs::metadata(slidra_path).map_err(|_| {
        SlidraError::invalid(format!("presentation file not found: {slidra_display}"))
    })?;
    if !metadata.is_file() {
        return Err(SlidraError::invalid(format!(
            "specified path is not a file: {slidra_display}"
        )));
    }

    let raw = std::fs::read(slidra_path).map_err(|_| {
        SlidraError::invalid(format!(
            "failed to read presentation file: {slidra_display}"
        ))
    })?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(raw)).map_err(|_| {
        SlidraError::invalid(format!(
            "presentation file is corrupted, cannot unzip: {slidra_display}"
        ))
    })?;

    let resolved_target_dir = target_dir.to_path_buf();
    // Validate every entry name before writing anything: a partially-
    // unpacked malicious archive is still a breach, so a bad entry must fail
    // the whole unpack rather than being skipped or silently sanitised.
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| {
            SlidraError::invalid(format!(
                "presentation file is corrupted, cannot unzip: {slidra_display}"
            ))
        })?;
        let name = entry.name().to_string();
        assert_entry_within_target(&name, &slidra_display)?;
    }

    let unpack_result = (|| -> SlidraResult<()> {
        std::fs::create_dir_all(target_dir).map_err(|_| {
            SlidraError::invalid(format!(
                "failed to unzip presentation file: {slidra_display}"
            ))
        })?;

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|_| {
                SlidraError::invalid(format!(
                    "failed to unzip presentation file: {slidra_display}"
                ))
            })?;
            let name = entry.name().to_string();
            let dest_path = join_relative(&resolved_target_dir, &name);
            if name.ends_with('/') {
                std::fs::create_dir_all(&dest_path).map_err(|_| {
                    SlidraError::invalid(format!(
                        "failed to unzip presentation file: {slidra_display}"
                    ))
                })?;
                continue;
            }
            if let Some(parent) = dest_path.parent() {
                std::fs::create_dir_all(parent).map_err(|_| {
                    SlidraError::invalid(format!(
                        "failed to unzip presentation file: {slidra_display}"
                    ))
                })?;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|_| {
                SlidraError::invalid(format!(
                    "failed to unzip presentation file: {slidra_display}"
                ))
            })?;
            std::fs::write(&dest_path, &buf).map_err(|_| {
                SlidraError::invalid(format!(
                    "failed to unzip presentation file: {slidra_display}"
                ))
            })?;
        }

        for &dir in REQUIRED_DIRS.iter() {
            std::fs::create_dir_all(target_dir.join(dir)).map_err(|_| {
                SlidraError::invalid(format!(
                    "failed to unzip presentation file: {slidra_display}"
                ))
            })?;
        }

        validate_project_json(target_dir, &slidra_display)?;
        assert_no_legacy_comotion_slides(target_dir, &slidra_display)?;
        Ok(())
    })();

    if unpack_result.is_err() {
        let _ = std::fs::remove_dir_all(target_dir);
    }
    unpack_result
}

/// Rejects an archive entry that is absolute or whose resolved destination
/// falls outside the target directory (unpack-side counterpart of the
/// read-side traversal guard `virtual_fs.rs` applies).
fn assert_entry_within_target(entry_path: &str, slidra_display: &str) -> SlidraResult<()> {
    if entry_path.starts_with('/') || entry_path.starts_with('\\') {
        return Err(SlidraError::invalid(format!(
            "presentation file contains an invalid path: {slidra_display}"
        )));
    }
    for segment in entry_path.split(['/', '\\']) {
        if segment == ".." {
            return Err(SlidraError::invalid(format!(
                "presentation file contains an invalid path: {slidra_display}"
            )));
        }
    }
    Ok(())
}

fn join_relative(base: &Path, relative: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    for segment in relative.split('/').filter(|s| !s.is_empty()) {
        path.push(segment);
    }
    path
}

/// Rejects a presentation whose slide SVGs still carry the old CoMotion
/// namespace markers (`xmlns:comot` or `co-motion.dev/ns`). Format version 1
/// is shared by both the old CoMotion format and the new Slidra format, so
/// the version number alone cannot tell them apart — reading one of the old
/// files anyway would silently lose its effects/notes/comments rather than
/// fail loudly. This is a hard rejection, not a compatibility parse: the
/// content is never interpreted or converted.
fn assert_no_legacy_comotion_slides(work_dir: &Path, slidra_display: &str) -> SlidraResult<()> {
    let slides_dir = work_dir.join("slides");
    let entries = match std::fs::read_dir(&slides_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("svg") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if content.contains("xmlns:comot") || content.contains("co-motion.dev/ns") {
            return Err(SlidraError::invalid(format!(
                "this presentation was made by CoMotion and is not supported by Slidra: {slidra_display}"
            )));
        }
    }
    Ok(())
}

fn validate_project_json(work_dir: &Path, slidra_display: &str) -> SlidraResult<()> {
    let project_json_path = work_dir.join("project.json");
    let raw = std::fs::read_to_string(&project_json_path).map_err(|_| {
        SlidraError::invalid(format!(
            "presentation file missing project.json: {slidra_display}"
        ))
    })?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
        SlidraError::invalid(format!("project.json is not valid JSON: {slidra_display}"))
    })?;

    // The structural check itself never mentions slidra_display (ADR-0004) —
    // both callers (open, serve) report the exact same wording for the exact
    // same malformed field.
    crate::workspace::project::validate_project_json_value(&parsed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-container-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn minimal_project_json() -> &'static str {
        r#"{"formatVersion":1,"name":"T","canvas":{"width":1280,"height":720},"slides":["slides/001.svg"],"fonts":[]}"#
    }

    #[test]
    fn pack_and_unpack_round_trips_content_exactly() {
        let source = temp_dir("pack-source");
        std::fs::create_dir_all(source.join("slides")).unwrap();
        std::fs::write(source.join("slides/001.svg"), b"<svg/>").unwrap();
        std::fs::write(source.join("project.json"), minimal_project_json()).unwrap();

        let slidra_path = temp_dir("pack-output").join("out.slidra");
        pack_directory(&source, &slidra_path).unwrap();

        let target = temp_dir("unpack-target");
        std::fs::remove_dir_all(&target).ok();
        unpack_container(&slidra_path, &target).unwrap();

        assert_eq!(
            std::fs::read(target.join("slides/001.svg")).unwrap(),
            b"<svg/>"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("project.json")).unwrap(),
            minimal_project_json()
        );
        assert!(target.join("assets").is_dir());
        assert!(target.join("fonts").is_dir());

        std::fs::remove_dir_all(&source).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    #[test]
    fn unpack_rejects_a_slide_svg_carrying_the_old_comotion_namespace() {
        let source = temp_dir("legacy-comot-source");
        std::fs::create_dir_all(source.join("slides")).unwrap();
        std::fs::write(
            source.join("slides/001.svg"),
            br#"<svg xmlns:comot="https://co-motion.dev/ns"></svg>"#,
        )
        .unwrap();
        std::fs::write(source.join("project.json"), minimal_project_json()).unwrap();

        let slidra_path = temp_dir("legacy-comot-output").join("out.slidra");
        pack_directory(&source, &slidra_path).unwrap();

        let target = temp_dir("legacy-comot-target");
        std::fs::remove_dir_all(&target).ok();
        let err = unpack_container(&slidra_path, &target).unwrap_err();
        assert!(
            err.to_string()
                .contains("this presentation was made by CoMotion and is not supported by Slidra"),
            "unexpected error: {err}"
        );

        std::fs::remove_dir_all(&source).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    #[test]
    fn pack_writes_empty_directory_entry_for_dirs_with_no_files() {
        let source = temp_dir("empty-dirs-source");
        std::fs::write(source.join("project.json"), minimal_project_json()).unwrap();
        // No slides/assets/fonts directories on disk at all.
        let slidra_path = temp_dir("empty-dirs-output").join("out.slidra");
        pack_directory(&source, &slidra_path).unwrap();

        let raw = std::fs::read(&slidra_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(raw)).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"slides/".to_string()));
        assert!(names.contains(&"assets/".to_string()));
        assert!(names.contains(&"fonts/".to_string()));

        std::fs::remove_dir_all(&source).ok();
    }

    #[test]
    fn pack_does_not_write_dir_entry_when_dir_has_files() {
        let source = temp_dir("nonempty-dirs-source");
        std::fs::create_dir_all(source.join("slides")).unwrap();
        std::fs::write(source.join("slides/001.svg"), b"<svg/>").unwrap();
        std::fs::write(source.join("project.json"), minimal_project_json()).unwrap();
        let slidra_path = temp_dir("nonempty-dirs-output").join("out.slidra");
        pack_directory(&source, &slidra_path).unwrap();

        let raw = std::fs::read(&slidra_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(raw)).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(!names.contains(&"slides/".to_string()));

        std::fs::remove_dir_all(&source).ok();
    }

    #[test]
    fn unpack_rejects_path_traversal_entry() {
        let mut buffer: Vec<u8> = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
            writer.start_file("../evil.txt", options).unwrap();
            writer.write_all(b"pwned").unwrap();
            writer.finish().unwrap();
        }
        let slidra_dir = temp_dir("traversal-source");
        let slidra_path = slidra_dir.join("evil.slidra");
        std::fs::write(&slidra_path, &buffer).unwrap();

        let target = temp_dir("traversal-target");
        std::fs::remove_dir_all(&target).ok();
        let err = unpack_container(&slidra_path, &target).unwrap_err();
        assert!(err.message().contains("invalid path"));
        assert!(!target.exists());

        std::fs::remove_dir_all(&slidra_dir).ok();
    }

    #[test]
    fn unpack_missing_project_json_fails_and_removes_target_dir() {
        let mut buffer: Vec<u8> = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
            writer.start_file("slides/001.svg", options).unwrap();
            writer.write_all(b"<svg/>").unwrap();
            writer.finish().unwrap();
        }
        let slidra_dir = temp_dir("no-project-json-source");
        let slidra_path = slidra_dir.join("bad.slidra");
        std::fs::write(&slidra_path, &buffer).unwrap();

        let target = temp_dir("no-project-json-target");
        std::fs::remove_dir_all(&target).ok();
        let err = unpack_container(&slidra_path, &target).unwrap_err();
        assert!(err.message().contains("missing project.json"));
        assert!(!target.exists());

        std::fs::remove_dir_all(&slidra_dir).ok();
    }

    #[test]
    fn unpack_nonexistent_file_errors() {
        let target = temp_dir("nonexistent-target");
        std::fs::remove_dir_all(&target).ok();
        let err = unpack_container(Path::new("/nonexistent/path/x.slidra"), &target).unwrap_err();
        assert!(err.message().contains("presentation file not found"));
    }
}
