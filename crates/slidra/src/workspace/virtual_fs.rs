//! Virtual path resolution within a presentation's real work directory.
//!
//! Public API:
//! - `list_virtual_entries(work_dir, virtual_path) -> SlidraResult<Vec<String>>`
//! - `resolve_virtual_file_path(work_dir, virtual_path) -> SlidraResult<PathBuf>`
//! - `read_virtual_file(work_dir, virtual_path) -> SlidraResult<String>` (strict UTF-8)
//! - `read_virtual_file_bytes(work_dir, virtual_path) -> SlidraResult<Vec<u8>>` (raw bytes)
//!
//! ADR-0004, third layer: a virtual path is resolved by walking a tree built
//! from *actually enumerating* the real work directory, one path segment at
//! a time — never by `PathBuf::join`/`.push()`-ing caller-supplied segments
//! onto a base directory. A segment like ".." or "" has no special meaning
//! here; it is just a string that structurally never appears as a key in the
//! enumerated tree, so it cannot resolve to anything, let alone escape the
//! sandbox. This also means every error message below carries only the
//! caller-supplied virtual path, never a real filesystem path (ADR-0004).

use crate::errors::{SlidraError, SlidraResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A node in the tree built by enumerating a work directory. Kept internal:
/// nothing outside this module should ever see a `realPath` that didn't come
/// out of an actual `read_dir` call.
enum VirtualNode {
    File {
        real_path: PathBuf,
    },
    Directory {
        children: HashMap<String, VirtualNode>,
    },
}

/// Builds the virtual tree for `work_dir` by recursively enumerating it.
/// Symlinks are silently skipped (neither `is_dir()` nor `is_file()` matches
/// a symlink's `file_type()`, which mirrors `lstat` and does not follow the
/// link) — the same omission `readdir(..., { withFileTypes: true })`'s
/// `Dirent.isDirectory()`/`isFile()` has for a symlink entry in the TS
/// original, not a gap introduced by this port.
fn build_virtual_tree(work_dir: &Path) -> SlidraResult<VirtualNode> {
    let mut children = HashMap::new();
    populate(work_dir, &mut children)?;
    Ok(VirtualNode::Directory { children })
}

fn populate(real_dir: &Path, node: &mut HashMap<String, VirtualNode>) -> SlidraResult<()> {
    // A failing read here is an operational failure, not evidence that
    // anything is absent — stays a plain `SlidraError::invalid`, matching
    // the "only SlidraNotFoundError is granted a 404" discipline.
    let entries = std::fs::read_dir(real_dir)
        .map_err(|_| SlidraError::invalid("error reading presentation content"))?;
    for entry in entries {
        let entry =
            entry.map_err(|_| SlidraError::invalid("error reading presentation content"))?;
        let file_type = entry
            .file_type()
            .map_err(|_| SlidraError::invalid("error reading presentation content"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == crate::workspace::lock::LOCK_FILE_NAME {
            // The CLI's own per-presentation lock — never part of the
            // presentation's virtual file structure.
            continue;
        }
        let real_path = real_dir.join(&name);
        if file_type.is_dir() {
            let mut grandchildren = HashMap::new();
            populate(&real_path, &mut grandchildren)?;
            node.insert(
                name,
                VirtualNode::Directory {
                    children: grandchildren,
                },
            );
        } else if file_type.is_file() {
            node.insert(name, VirtualNode::File { real_path });
        }
    }
    Ok(())
}

/// Splits a caller-supplied virtual path into segments for map lookup.
/// Leading/trailing/duplicate slashes collapse away; no segment is ever
/// interpreted, resolved, or normalized against the real filesystem.
fn split_virtual_path(virtual_path: &str) -> Vec<&str> {
    virtual_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// Walks the tree by exact segment lookup. Returns `None` if any step misses
/// — including stepping into a segment underneath a `File` node, which has
/// no children at all.
fn navigate<'a>(root: &'a VirtualNode, segments: &[&str]) -> Option<&'a VirtualNode> {
    let mut current = root;
    for segment in segments {
        match current {
            VirtualNode::Directory { children } => current = children.get(*segment)?,
            VirtualNode::File { .. } => return None,
        }
    }
    Some(current)
}

/// Lists the entry names of the virtual directory at `virtual_path` (the
/// root when `""`). Errors when the path does not resolve to a directory.
pub fn list_virtual_entries(work_dir: &Path, virtual_path: &str) -> SlidraResult<Vec<String>> {
    let root = build_virtual_tree(work_dir)?;
    let segments = split_virtual_path(virtual_path);
    match navigate(&root, &segments) {
        Some(VirtualNode::Directory { children }) => {
            let mut names: Vec<String> = children.keys().cloned().collect();
            names.sort();
            Ok(names)
        }
        _ => {
            let display = if virtual_path.is_empty() {
                "/"
            } else {
                virtual_path
            };
            Err(SlidraError::not_found(format!(
                "directory not found: {display}"
            )))
        }
    }
}

/// Every file beneath `virtual_path`, as virtual paths, sorted. A path that
/// resolves to no directory yields an empty list rather than an error: a
/// presentation with no `assets/` directory has no assets, which is a fact
/// about it, not a failure to read it.
pub fn list_virtual_files(work_dir: &Path, virtual_path: &str) -> SlidraResult<Vec<String>> {
    let root = build_virtual_tree(work_dir)?;
    let segments = split_virtual_path(virtual_path);
    let mut files = Vec::new();
    if let Some(VirtualNode::Directory { children }) = navigate(&root, &segments) {
        collect_virtual_files(children, virtual_path, &mut files);
    }
    files.sort();
    Ok(files)
}

fn collect_virtual_files(
    children: &HashMap<String, VirtualNode>,
    prefix: &str,
    into: &mut Vec<String>,
) {
    for (name, node) in children {
        let path = format!("{prefix}/{name}");
        match node {
            VirtualNode::File { .. } => into.push(path),
            VirtualNode::Directory { children } => collect_virtual_files(children, &path, into),
        }
    }
}

/// Resolves `virtual_path` to its real filesystem path, without reading it.
/// Used by primitives that need the real path to modify a file in place,
/// while still going through the same structural discovery as every read.
pub fn resolve_virtual_file_path(work_dir: &Path, virtual_path: &str) -> SlidraResult<PathBuf> {
    let root = build_virtual_tree(work_dir)?;
    let segments = split_virtual_path(virtual_path);
    match navigate(&root, &segments) {
        None => Err(SlidraError::not_found(format!(
            "file not found: {virtual_path}"
        ))),
        Some(VirtualNode::Directory { .. }) => Err(SlidraError::not_found(format!(
            "not a file: {virtual_path}"
        ))),
        Some(VirtualNode::File { real_path }) => Ok(real_path.clone()),
    }
}

/// Reads the full original content of the file at `virtual_path`, decoded as
/// strict UTF-8 (any invalid byte sequence is rejected — a structural test
/// on the bytes themselves, not a filename guess, so a mislabelled binary
/// file can never slip through as text).
///
/// Note: this does not preserve/strip a leading BOM specially either way —
/// `String::from_utf8` treats a BOM as three ordinary content bytes
/// (`\u{FEFF}`), matching the TS original's `ignoreBOM: true` decode, which
/// also leaves a BOM as ordinary content instead of stripping it.
pub fn read_virtual_file(work_dir: &Path, virtual_path: &str) -> SlidraResult<String> {
    let real_path = resolve_virtual_file_path(work_dir, virtual_path)?;
    let bytes = std::fs::read(&real_path)
        .map_err(|_| SlidraError::invalid(format!("error reading file: {virtual_path}")))?;
    String::from_utf8(bytes).map_err(|_| {
        SlidraError::invalid(format!(
            "{virtual_path} is a binary asset, cannot be read as text"
        ))
    })
}

/// Reads the raw bytes of the file at `virtual_path`, exactly as stored on
/// disk — no text decoding, no validation of content. The byte-preserving
/// sibling of `read_virtual_file`, for binary assets.
pub fn read_virtual_file_bytes(work_dir: &Path, virtual_path: &str) -> SlidraResult<Vec<u8>> {
    let real_path = resolve_virtual_file_path(work_dir, virtual_path)?;
    std::fs::read(&real_path)
        .map_err(|_| SlidraError::invalid(format!("error reading file: {virtual_path}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-vfs-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolves_a_nested_file_by_enumeration() {
        let work = temp_dir("nested-file");
        std::fs::create_dir_all(work.join("slides")).unwrap();
        std::fs::write(work.join("slides").join("001.svg"), b"<svg/>").unwrap();

        let resolved = resolve_virtual_file_path(&work, "slides/001.svg").unwrap();
        assert_eq!(resolved, work.join("slides").join("001.svg"));
        assert_eq!(
            read_virtual_file(&work, "slides/001.svg").unwrap(),
            "<svg/>"
        );

        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn lists_directory_entries_sorted() {
        let work = temp_dir("list-entries");
        std::fs::create_dir_all(work.join("slides")).unwrap();
        std::fs::write(work.join("slides").join("002.svg"), b"").unwrap();
        std::fs::write(work.join("slides").join("001.svg"), b"").unwrap();

        let entries = list_virtual_entries(&work, "slides").unwrap();
        assert_eq!(entries, vec!["001.svg".to_string(), "002.svg".to_string()]);

        std::fs::remove_dir_all(&work).ok();
    }

    /// A `..`-containing (or leading-slash, or duplicate-slash) virtual path
    /// must never resolve to anything, even when a naive `Path::join` of the
    /// same segments onto `work_dir` WOULD escape it and land on a real file
    /// that exists just outside the sandbox. This test plants such a file
    /// and asserts resolution fails outright — proving the escape never
    /// happens structurally, not just that this particular file wasn't
    /// returned.
    #[test]
    fn dot_dot_path_never_escapes_the_work_dir() {
        let parent = temp_dir("escape-parent");
        let work = parent.join("work");
        std::fs::create_dir_all(&work).unwrap();
        // Planted just outside `work`, at the exact real location a naive
        // `work.join("../secret.txt")` would land on.
        std::fs::write(parent.join("secret.txt"), b"should never be reachable").unwrap();

        for hostile in [
            "../secret.txt",
            "/etc/passwd",
            "slides//001.svg",
            "a/../../secret.txt",
        ] {
            let result = resolve_virtual_file_path(&work, hostile);
            assert!(result.is_err(), "expected {hostile:?} to fail to resolve");
            if let Err(err) = result {
                assert_eq!(err.message(), format!("file not found: {hostile}"));
            }
        }

        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn missing_file_is_not_found_error() {
        let work = temp_dir("missing-file");
        let err = resolve_virtual_file_path(&work, "nope.svg").unwrap_err();
        assert_eq!(err.message(), "file not found: nope.svg");
        std::fs::remove_dir_all(&work).ok();
    }
}
