// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Virtual path resolution within a presentation's SQLite deck
//! (`deck_path`, the `.slidra` file itself — `deck.rs`).
//!
//! Public API:
//! - `list_virtual_entries(deck_path, virtual_path) -> SlidraResult<Vec<String>>`
//! - `list_virtual_files(deck_path, virtual_path) -> SlidraResult<Vec<String>>`
//! - `assert_file_exists(deck_path, virtual_path) -> SlidraResult<()>`
//! - `read_virtual_file(deck_path, virtual_path) -> SlidraResult<String>` (strict UTF-8)
//! - `read_virtual_file_bytes(deck_path, virtual_path) -> SlidraResult<Vec<u8>>` (raw bytes)
//! - `write_existing_file`/`create_new_file`/`delete_file`/`force_write_file`/
//!   `delete_file_if_present`/`delete_dir_recursive` — the content-write
//!   primitives `write.rs`, `history.rs` and `plan/mod.rs` build on.
//!
//! Every path is a row in the deck's `content` table (`path TEXT UNIQUE`,
//! `kind` 0=file/1=dir, `data` BLOB) — ADR-0003's "never resolve a
//! caller-supplied path by joining it onto a base directory" now reads as
//! "never resolve one by string-concatenating it into SQL": every query
//! here binds `virtual_path` as a parameter, and a segment like `..` or an
//! empty string has no special meaning to an exact `path = ?` lookup, so
//! it simply matches no row rather than escaping anything. Root (`""`) is
//! not a row — it is always treated as an existing directory, mirroring
//! the old real-directory tree's root.
//!
//! A directory's existence is tracked by an explicit `kind = 1` row, never
//! derived from "some file's path happens to start with this prefix" —
//! that distinction is what makes an *existing but empty* directory
//! (`ls` -> `[]`) different from a *non-existent* one (`ls` -> `NotFound`),
//! same as the old real-directory version (an empty real directory vs. one
//! that was never `mkdir`'d).

use crate::deck::{self, KIND_DIR, KIND_FILE};
use crate::errors::{SlidraError, SlidraResult};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

fn io_err(_: rusqlite::Error) -> SlidraError {
    SlidraError::invalid("error reading presentation content")
}

/// Opens the deck connection, stripping any real filesystem path out of a
/// failure (ADR-0003): `deck::open_connection`'s own errors legitimately
/// include `deck_path` when the caller of `deck::` itself supplied that
/// path directly (`commands::open`'s own validation) — but every caller
/// here reaches `deck_path` indirectly, through an opaque presentation id
/// resolved via the registry, so that path must never reach this crate's
/// output from this direction.
fn open(deck_path: &Path) -> SlidraResult<Connection> {
    deck::open_connection(deck_path)
        .map_err(|_| SlidraError::invalid("error reading presentation content"))
}

/// The `kind` of the row at `virtual_path`, or `None` when no such row
/// exists. `virtual_path == ""` (root) is never looked up as a row — every
/// caller here special-cases it first.
fn row_kind(conn: &Connection, virtual_path: &str) -> SlidraResult<Option<i64>> {
    conn.query_row(
        "SELECT kind FROM content WHERE path = ?1",
        params![virtual_path],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(io_err)
}

/// Every `(path, kind)` row in the deck — used by the two listing
/// functions, which filter in Rust rather than via SQL `LIKE` (a virtual
/// path may legally contain `%`/`_`, which `LIKE` would otherwise treat as
/// wildcards) and are fine doing so at a single deck's scale.
fn all_rows(conn: &Connection) -> SlidraResult<Vec<(String, i64)>> {
    let mut stmt = conn
        .prepare("SELECT path, kind FROM content")
        .map_err(io_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(io_err)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(io_err)?);
    }
    Ok(out)
}

/// Lists the entry names of the virtual directory at `virtual_path` (the
/// root when `""`). Errors when the path does not resolve to a directory.
pub fn list_virtual_entries(deck_path: &Path, virtual_path: &str) -> SlidraResult<Vec<String>> {
    let conn = open(deck_path)?;
    if !virtual_path.is_empty() && row_kind(&conn, virtual_path)? != Some(KIND_DIR) {
        return Err(not_found_dir(virtual_path));
    }
    let prefix = if virtual_path.is_empty() {
        String::new()
    } else {
        format!("{virtual_path}/")
    };
    let mut names = std::collections::BTreeSet::new();
    for (path, _kind) in all_rows(&conn)? {
        let Some(remainder) = path.strip_prefix(&prefix) else {
            continue;
        };
        if remainder.is_empty() {
            continue;
        }
        let name = remainder
            .split('/')
            .next()
            .expect("split always yields at least one part");
        names.insert(name.to_string());
    }
    Ok(names.into_iter().collect())
}

fn not_found_dir(virtual_path: &str) -> SlidraError {
    let display = if virtual_path.is_empty() {
        "/"
    } else {
        virtual_path
    };
    SlidraError::not_found(format!("directory not found: {display}"))
}

/// Every file beneath `virtual_path`, as virtual paths, sorted. A path that
/// resolves to no directory yields an empty list rather than an error: a
/// presentation with no `assets/` directory has no assets, which is a fact
/// about it, not a failure to read it.
pub fn list_virtual_files(deck_path: &Path, virtual_path: &str) -> SlidraResult<Vec<String>> {
    let conn = open(deck_path)?;
    if !virtual_path.is_empty() && row_kind(&conn, virtual_path)? != Some(KIND_DIR) {
        return Ok(Vec::new());
    }
    let prefix = if virtual_path.is_empty() {
        String::new()
    } else {
        format!("{virtual_path}/")
    };
    let mut files: Vec<String> = all_rows(&conn)?
        .into_iter()
        .filter(|(path, kind)| {
            *kind == KIND_FILE && (prefix.is_empty() || path.starts_with(&prefix))
        })
        .map(|(path, _)| path)
        .collect();
    files.sort();
    Ok(files)
}

/// Every directory virtual path in the deck (the root `""` is never
/// included — it is implicit, not a row), sorted — `commands::extract`'s
/// only way to reproduce an empty directory on disk, since
/// `list_virtual_files` alone carries no evidence a directory with no
/// files in it ever existed.
pub fn list_virtual_dirs(deck_path: &Path) -> SlidraResult<Vec<String>> {
    let conn = open(deck_path)?;
    let mut dirs: Vec<String> = all_rows(&conn)?
        .into_iter()
        .filter(|(_, kind)| *kind == KIND_DIR)
        .map(|(path, _)| path)
        .collect();
    dirs.sort();
    Ok(dirs)
}

/// Confirms a file (not a directory) exists at `virtual_path`, without
/// reading it. Replaces the old real-filesystem version's `PathBuf`
/// return: there is no "real path" to hand back any more, so every call
/// site that used to dereference one now reads the file through
/// `read_virtual_file`/`read_virtual_file_bytes` instead — see
/// `commands::convert`, `plan::delete_plan`, `history`'s own content
/// reads/writes.
pub fn assert_file_exists(deck_path: &Path, virtual_path: &str) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    match row_kind(&conn, virtual_path)? {
        Some(KIND_FILE) => Ok(()),
        Some(_) => Err(SlidraError::not_found(format!(
            "not a file: {virtual_path}"
        ))),
        None => Err(SlidraError::not_found(format!(
            "file not found: {virtual_path}"
        ))),
    }
}

fn read_bytes(conn: &Connection, virtual_path: &str) -> SlidraResult<Vec<u8>> {
    match row_kind(conn, virtual_path)? {
        Some(KIND_FILE) => {}
        Some(_) => {
            return Err(SlidraError::not_found(format!(
                "not a file: {virtual_path}"
            )));
        }
        None => {
            return Err(SlidraError::not_found(format!(
                "file not found: {virtual_path}"
            )));
        }
    }
    conn.query_row(
        "SELECT data FROM content WHERE path = ?1",
        params![virtual_path],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .map_err(|_| SlidraError::invalid(format!("error reading file: {virtual_path}")))
}

/// Reads the full original content of the file at `virtual_path`, decoded as
/// strict UTF-8 (any invalid byte sequence is rejected — a structural test
/// on the bytes themselves, not a filename guess, so a mislabelled binary
/// file can never slip through as text).
pub fn read_virtual_file(deck_path: &Path, virtual_path: &str) -> SlidraResult<String> {
    let conn = open(deck_path)?;
    let bytes = read_bytes(&conn, virtual_path)?;
    String::from_utf8(bytes).map_err(|_| {
        SlidraError::invalid(format!(
            "{virtual_path} is a binary asset, cannot be read as text"
        ))
    })
}

/// Reads the raw bytes of the file at `virtual_path`, exactly as stored —
/// no text decoding, no validation of content. The byte-preserving sibling
/// of `read_virtual_file`, for binary assets.
pub fn read_virtual_file_bytes(deck_path: &Path, virtual_path: &str) -> SlidraResult<Vec<u8>> {
    let conn = open(deck_path)?;
    read_bytes(&conn, virtual_path)
}

/// Overwrites the content of a file that must already exist —
/// `write_presentation_file`/`write_presentation_file_without_history`'s
/// primitive. `NotFound` if `virtual_path` is not an existing file (a
/// directory, or nothing at all).
pub fn write_existing_file(
    deck_path: &Path,
    virtual_path: &str,
    content: &[u8],
) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    let affected = conn
        .execute(
            "UPDATE content SET data = ?1 WHERE path = ?2 AND kind = ?3",
            params![content, virtual_path, KIND_FILE],
        )
        .map_err(io_err)?;
    if affected == 0 {
        return Err(SlidraError::not_found(format!(
            "file not found: {virtual_path}"
        )));
    }
    Ok(())
}

/// Creates a new file at `virtual_path`, which must not already exist as a
/// file — `create_presentation_file`'s primitive. Ancestor directory rows
/// are created automatically (the SQLite-backed equivalent of the old
/// `create_dir_all(parent)`).
pub fn create_new_file(deck_path: &Path, virtual_path: &str, content: &[u8]) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    if row_kind(&conn, virtual_path)? == Some(KIND_FILE) {
        return Err(SlidraError::invalid(format!(
            "file already exists: {virtual_path}"
        )));
    }
    let display = deck_path.display().to_string();
    deck::ensure_ancestor_dirs(&conn, virtual_path, &display)?;
    conn.execute(
        "INSERT INTO content (path, kind, data) VALUES (?1, ?2, ?3)",
        params![virtual_path, KIND_FILE, content],
    )
    .map_err(|_| SlidraError::invalid(format!("error writing file: {virtual_path}")))?;
    Ok(())
}

/// Deletes an existing file — `delete_presentation_file`'s primitive. The
/// caller (`write::delete_presentation_file`) already confirms the file
/// exists via `assert_file_exists` before calling this, so `affected == 0`
/// here only happens if that invariant is ever broken — reported the same
/// way an I/O failure would be, never silently ignored.
pub fn delete_file(deck_path: &Path, virtual_path: &str) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    let affected = conn
        .execute(
            "DELETE FROM content WHERE path = ?1 AND kind = ?2",
            params![virtual_path, KIND_FILE],
        )
        .map_err(io_err)?;
    if affected == 0 {
        return Err(SlidraError::invalid(format!(
            "error deleting file: {virtual_path}"
        )));
    }
    Ok(())
}

/// Creates-or-overwrites a file regardless of whether it currently exists
/// — `history.rs`'s undo/redo restore step, which may be putting back
/// content for a path that a later edit deleted (create) or merely changed
/// (overwrite). Ancestor directory rows are created automatically.
pub fn force_write_file(deck_path: &Path, virtual_path: &str, content: &[u8]) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    let display = deck_path.display().to_string();
    deck::ensure_ancestor_dirs(&conn, virtual_path, &display)?;
    conn.execute(
        "INSERT INTO content (path, kind, data) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET data = excluded.data, kind = excluded.kind",
        params![virtual_path, KIND_FILE, content],
    )
    .map_err(|_| SlidraError::invalid(format!("error writing slide: {virtual_path}")))?;
    Ok(())
}

/// Deletes a file if it currently exists; a no-op otherwise — undoing a
/// creation twice must not be an error (`history.rs`).
pub fn delete_file_if_present(deck_path: &Path, virtual_path: &str) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    conn.execute(
        "DELETE FROM content WHERE path = ?1 AND kind = ?2",
        params![virtual_path, KIND_FILE],
    )
    .map_err(|_| SlidraError::invalid(format!("error deleting file: {virtual_path}")))?;
    Ok(())
}

/// Deletes `virtual_path` and everything nested under it — `plan
/// delete`'s whole-directory form. The caller is responsible for
/// confirming the directory exists first (`list_virtual_entries` already
/// errors `NotFound` otherwise); this function itself does not
/// distinguish "deleted nothing" from "deleted an already-empty
/// directory".
pub fn delete_dir_recursive(deck_path: &Path, virtual_path: &str) -> SlidraResult<()> {
    let conn = open(deck_path)?;
    conn.execute("DELETE FROM content WHERE path = ?1", params![virtual_path])
        .map_err(io_err)?;
    let prefix = format!("{virtual_path}/");
    for (path, _kind) in all_rows(&conn)? {
        if path.starts_with(&prefix) {
            conn.execute("DELETE FROM content WHERE path = ?1", params![path])
                .map_err(io_err)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::build_test_deck;

    #[test]
    fn resolves_a_nested_file_by_exact_path() {
        let deck = build_test_deck("nested-file", &[("slides/001.svg", b"<svg/>")]);
        assert_file_exists(&deck, "slides/001.svg").unwrap();
        assert_eq!(
            read_virtual_file(&deck, "slides/001.svg").unwrap(),
            "<svg/>"
        );
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn lists_directory_entries_sorted() {
        let deck = build_test_deck(
            "list-entries",
            &[("slides/002.svg", b""), ("slides/001.svg", b"")],
        );
        let entries = list_virtual_entries(&deck, "slides").unwrap();
        assert_eq!(entries, vec!["001.svg".to_string(), "002.svg".to_string()]);
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn dot_dot_path_never_resolves_to_anything() {
        let deck = build_test_deck("escape", &[("slides/001.svg", b"<svg/>")]);
        for hostile in [
            "../secret.txt",
            "/etc/passwd",
            "slides//001.svg",
            "a/../../secret.txt",
        ] {
            let result = assert_file_exists(&deck, hostile);
            assert!(result.is_err(), "expected {hostile:?} to fail to resolve");
        }
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn missing_file_is_not_found_error() {
        let deck = build_test_deck("missing", &[]);
        let err = assert_file_exists(&deck, "nope.svg").unwrap_err();
        assert_eq!(err.message(), "file not found: nope.svg");
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn empty_existing_directory_lists_empty_not_not_found() {
        let deck = build_test_deck("empty-dir", &[]);
        // `assets/` is one of `container::REQUIRED_DIRS`, always present
        // even with no files in it.
        assert_eq!(
            list_virtual_entries(&deck, "assets").unwrap(),
            Vec::<String>::new()
        );
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn never_created_directory_is_not_found() {
        let deck = build_test_deck("never-created", &[]);
        let err = list_virtual_entries(&deck, "assets/data").unwrap_err();
        assert!(matches!(err, SlidraError::NotFound(_)));
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn write_existing_file_requires_the_file_to_already_exist() {
        let deck = build_test_deck("write-existing", &[("slides/001.svg", b"before")]);
        write_existing_file(&deck, "slides/001.svg", b"after").unwrap();
        assert_eq!(
            read_virtual_file_bytes(&deck, "slides/001.svg").unwrap(),
            b"after"
        );
        let err = write_existing_file(&deck, "slides/999.svg", b"x").unwrap_err();
        assert!(matches!(err, SlidraError::NotFound(_)));
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn create_new_file_rejects_an_existing_path_and_auto_creates_ancestors() {
        let deck = build_test_deck("create-new", &[("slides/001.svg", b"x")]);
        let err = create_new_file(&deck, "slides/001.svg", b"y").unwrap_err();
        assert_eq!(err.message(), "file already exists: slides/001.svg");
        create_new_file(&deck, "assets/data/x.csv", b"a,b").unwrap();
        assert_eq!(
            read_virtual_file_bytes(&deck, "assets/data/x.csv").unwrap(),
            b"a,b"
        );
        assert_eq!(
            list_virtual_entries(&deck, "assets/data").unwrap(),
            vec!["x.csv".to_string()]
        );
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn delete_file_removes_it() {
        let deck = build_test_deck("delete", &[("slides/001.svg", b"x")]);
        delete_file(&deck, "slides/001.svg").unwrap();
        assert!(assert_file_exists(&deck, "slides/001.svg").is_err());
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn force_write_file_creates_or_overwrites() {
        let deck = build_test_deck("force-write", &[]);
        force_write_file(&deck, "assets/new.png", b"created").unwrap();
        assert_eq!(
            read_virtual_file_bytes(&deck, "assets/new.png").unwrap(),
            b"created"
        );
        force_write_file(&deck, "assets/new.png", b"overwritten").unwrap();
        assert_eq!(
            read_virtual_file_bytes(&deck, "assets/new.png").unwrap(),
            b"overwritten"
        );
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn delete_file_if_present_is_idempotent() {
        let deck = build_test_deck("delete-if-present", &[("assets/x.png", b"x")]);
        delete_file_if_present(&deck, "assets/x.png").unwrap();
        delete_file_if_present(&deck, "assets/x.png").unwrap();
        assert!(assert_file_exists(&deck, "assets/x.png").is_err());
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn delete_dir_recursive_removes_the_directory_and_its_contents() {
        let deck = build_test_deck(
            "delete-dir",
            &[("plan/outline.md", b"x"), ("plan/design.md", b"y")],
        );
        delete_dir_recursive(&deck, "plan").unwrap();
        assert!(list_virtual_entries(&deck, "plan").is_err());
        std::fs::remove_file(&deck).ok();
    }
}
