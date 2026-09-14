// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The `.slidra` SQLite container: connection lifecycle (open/create) and
//! legacy-ZIP-to-SQLite migration. `virtual_fs.rs` is the only caller of
//! this module's row-level reads/writes — see its module doc for the
//! `content` table's shape and the virtual-path semantics built on top of
//! it. This module owns exactly three things: telling a `.slidra` file's
//! container format apart by its header bytes (never its extension),
//! opening a connection to an already-valid deck with this crate's fixed
//! pragmas, and migrating a legacy ZIP deck to SQLite in place.
//!
//! `journal_mode=DELETE` (the SQLite default, set explicitly here so a
//! deck ported from a build with a different default stays byte-for-byte
//! predictable) is a deliberate choice over WAL: a rollback journal is
//! created for the duration of one write transaction and unlinked the
//! moment that transaction commits, so "the deck's directory holds exactly
//! one file once the process closes it" (AC4) is a structural guarantee of
//! the journal mode itself, not something this crate has to remember to
//! clean up. WAL would instead leave `-wal`/`-shm` siblings that only a
//! `PRAGMA wal_checkpoint(TRUNCATE)` (itself not exception-safe against a
//! process that dies mid-command) removes. Concurrent access across two
//! `slidra` processes is already serialized by `workspace::lock`'s
//! per-deck advisory lock before either one ever opens a connection here,
//! so WAL's main advantage — readers not blocking a writer — buys nothing
//! this crate needs.

use crate::errors::{SlidraError, SlidraResult};
use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;

/// Stored in the SQLite header's `application_id` field (`PRAGMA
/// application_id`) so a `.slidra` file can be told apart from an
/// arbitrary SQLite database that merely happens to carry this extension —
/// ASCII "Sldr".
const APPLICATION_ID: i32 = 0x536c_6472;

/// A file kind bit in `content.kind`: an ordinary file, `data` holds its
/// bytes.
pub const KIND_FILE: i64 = 0;
/// A file kind bit in `content.kind`: an explicit directory marker,
/// `data` is always `NULL`. Directories are listed as rows precisely so
/// "exists but empty" (`ls` returns `[]`) and "does not exist" (`ls`
/// errors `NotFound`) stay distinguishable — an implicit, prefix-derived
/// notion of "directory" cannot tell those two apart (see `virtual_fs`'s
/// module doc).
pub const KIND_DIR: i64 = 1;

const SCHEMA_SQL: &str = "CREATE TABLE content (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    kind INTEGER NOT NULL,
    data BLOB
)";

/// Undo-history side tables — [E6.T6]: created lazily (`IF NOT EXISTS`) by
/// `history::ensure_schema` at the start of every `history` module
/// operation, never as part of `SCHEMA_SQL`/`user_version` above. A deck
/// written before this ticket (or a fresh `new`) simply has none of these
/// three tables until its first history operation; that absence is read as
/// an empty history (`docs/spec/workspace.md`), not a format migration to
/// run. No `FOREIGN KEY`/`CASCADE`: `history.rs` deletes rows explicitly on
/// its own eviction/finalize schedule, which deliberately does not line up
/// with a naive cascading delete (a group is deleted before its snapshots
/// in some paths, after in others — see `history::write_stack`).
///
/// - `history_group`: one row per undo/redo/open-group entry. `stack` is
///   0=undo, 1=redo, 2=the (at most one) open group; `position` orders
///   entries within the same `stack` value, ascending oldest-to-newest —
///   matching `Vec::push`/`Vec::pop`'s stack-at-the-end convention, so
///   `position 0` is always the oldest surviving entry.
/// - `history_entry`: one row per entry inside a group, `position`-ordered
///   within `group_rowid` (a `history_group.id` value, never enforced by a
///   real foreign key — see above). `snapshot_id` is nullable: `NULL` means
///   the entry's `virtual_path` did not exist before the edit it records.
/// - `history_snapshot`: one row per snapshot, addressed by its opaque
///   `snapshot_id`, holding the path's full prior content as a blob.
const HISTORY_GROUP_TABLE_SQL: &str = "CREATE TABLE IF NOT EXISTS history_group (
    id INTEGER PRIMARY KEY,
    group_id TEXT NOT NULL,
    stack INTEGER NOT NULL,
    position INTEGER NOT NULL
)";

const HISTORY_ENTRY_TABLE_SQL: &str = "CREATE TABLE IF NOT EXISTS history_entry (
    id INTEGER PRIMARY KEY,
    group_rowid INTEGER NOT NULL,
    position INTEGER NOT NULL,
    virtual_path TEXT NOT NULL,
    snapshot_id TEXT
)";

const HISTORY_SNAPSHOT_TABLE_SQL: &str = "CREATE TABLE IF NOT EXISTS history_snapshot (
    snapshot_id TEXT PRIMARY KEY,
    data BLOB NOT NULL
)";

/// Lazily creates the three undo-history side tables (above) inside an
/// already-open deck connection. Idempotent and cheap to call on every
/// `history` module operation: once the tables exist, `IF NOT EXISTS`
/// makes every later call a no-op that writes nothing to the file.
pub(crate) fn ensure_history_schema(conn: &Connection) -> SlidraResult<()> {
    for stmt in [
        HISTORY_GROUP_TABLE_SQL,
        HISTORY_ENTRY_TABLE_SQL,
        HISTORY_SNAPSHOT_TABLE_SQL,
    ] {
        conn.execute(stmt, [])
            .map_err(|_| SlidraError::invalid("failed to prepare undo history"))?;
    }
    Ok(())
}

/// A `.slidra` file's on-disk container format, told apart by header bytes
/// alone (never the file extension) — `docs/spec/slidra-format.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerFormat {
    Sqlite,
    LegacyZip,
}

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Sniffs `path`'s container format from its header bytes. `NotFound` when
/// the path does not exist at all; a plain `SlidraError` for every other
/// read failure or an unrecognized header, mirroring `unpack_container`'s
/// old error wording so callers that already matched on it (`open`, `pack`
/// prerequisites) keep working.
pub fn detect_format(path: &Path) -> SlidraResult<ContainerFormat> {
    let display = path.display().to_string();
    let metadata = std::fs::metadata(path)
        .map_err(|_| SlidraError::invalid(format!("presentation file not found: {display}")))?;
    if !metadata.is_file() {
        return Err(SlidraError::invalid(format!(
            "specified path is not a file: {display}"
        )));
    }
    let bytes = std::fs::read(path).map_err(|_| {
        SlidraError::invalid(format!("failed to read presentation file: {display}"))
    })?;
    if bytes.len() >= 16 && bytes[..16] == *SQLITE_MAGIC {
        return Ok(ContainerFormat::Sqlite);
    }
    if bytes.len() >= 4 && bytes[0] == b'P' && bytes[1] == b'K' {
        return Ok(ContainerFormat::LegacyZip);
    }
    Err(SlidraError::invalid(format!(
        "presentation file is corrupted: {display}"
    )))
}

/// Applies this crate's fixed pragmas to a freshly-opened connection —
/// shared by `open_connection` (an existing deck) and `create_new` (a
/// brand-new one), so the two can never drift.
fn apply_pragmas(conn: &Connection) -> SlidraResult<()> {
    conn.pragma_update(None, "journal_mode", "DELETE")
        .map_err(|_| SlidraError::invalid("failed to configure presentation file"))?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|_| SlidraError::invalid("failed to configure presentation file"))?;
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(|_| SlidraError::invalid("failed to configure presentation file"))?;
    Ok(())
}

/// Opens a connection to an already-valid `.slidra` SQLite deck at `path`,
/// verifying `application_id` and `user_version` before handing it back —
/// every row-level read/write in `virtual_fs.rs` goes through this. Does
/// NOT migrate a legacy ZIP (that is `commands::open`'s one-time job via
/// `migrate_legacy_zip_in_place`) and does NOT create a missing file —
/// callers here are always operating on a deck the registry already points
/// at, which `open` guarantees is a valid SQLite deck.
pub fn open_connection(path: &Path) -> SlidraResult<Connection> {
    let display = path.display().to_string();
    let conn = Connection::open(path).map_err(|_| {
        SlidraError::invalid(format!("failed to read presentation file: {display}"))
    })?;
    apply_pragmas(&conn)?;

    let application_id: i64 = conn
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|_| SlidraError::invalid(format!("presentation file is corrupted: {display}")))?;
    if application_id != i64::from(APPLICATION_ID) {
        return Err(SlidraError::invalid(format!(
            "presentation file is corrupted: {display}"
        )));
    }
    let user_version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| SlidraError::invalid(format!("presentation file is corrupted: {display}")))?;
    let current = i64::from(crate::presentation::FORMAT_VERSION);
    if user_version > current {
        return Err(SlidraError::invalid(format!(
            "presentation file was created by a newer version of slidra and cannot be opened: {display}"
        )));
    }
    if user_version != current {
        return Err(SlidraError::invalid(format!(
            "presentation file is corrupted: {display}"
        )));
    }
    Ok(conn)
}

/// Creates a brand-new `.slidra` SQLite deck at `path`, overwriting
/// whatever was there before (matching the old `pack_directory`'s
/// unconditional overwrite — `new`'s own contract, not a behavior change).
/// Returns the open connection, schema created and pragmas applied, ready
/// for the caller to insert rows into (still inside the same connection,
/// so the required-directory rows and `project.json` land in the same
/// file this function just created).
pub fn create_new(path: &Path) -> SlidraResult<Connection> {
    let display = path.display().to_string();
    let _ = std::fs::remove_file(path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|_| {
                SlidraError::invalid(format!("failed to write presentation file: {display}"))
            })?;
        }
    }
    let conn = Connection::open(path).map_err(|_| {
        SlidraError::invalid(format!("failed to write presentation file: {display}"))
    })?;
    apply_pragmas(&conn)?;
    conn.pragma_update(None, "application_id", i64::from(APPLICATION_ID))
        .map_err(|_| {
            SlidraError::invalid(format!("failed to write presentation file: {display}"))
        })?;
    conn.pragma_update(
        None,
        "user_version",
        i64::from(crate::presentation::FORMAT_VERSION),
    )
    .map_err(|_| SlidraError::invalid(format!("failed to write presentation file: {display}")))?;
    conn.execute(SCHEMA_SQL, []).map_err(|_| {
        SlidraError::invalid(format!("failed to write presentation file: {display}"))
    })?;
    Ok(conn)
}

/// Migrates a legacy ZIP deck at `path` to the SQLite container format, in
/// place: the new deck is fully built at a sibling temp file
/// (`<name>.slidra.migrating-<hex>`) first, and only `rename`d over `path`
/// once it is completely written — a failure at any point before the
/// rename removes the temp file and leaves `path` byte-for-byte untouched.
/// A no-op (`Ok(())` immediately) when `path` is already a SQLite deck —
/// `commands::open` calls this unconditionally and relies on that
/// idempotence to keep "migrate if needed" a single call.
pub fn migrate_legacy_zip_in_place(path: &Path) -> SlidraResult<()> {
    if detect_format(path)? != ContainerFormat::LegacyZip {
        return Ok(());
    }
    let files = crate::container::read_legacy_zip(path)?;

    let temp_name = format!(
        "{}.migrating-{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "deck".to_string()),
        crate::id::random_hex_suffix()
    );
    let temp_path = path.with_file_name(temp_name);

    let build_result = build_deck_from_files(&temp_path, &files);
    if build_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
        return build_result;
    }

    let display = path.display().to_string();
    std::fs::rename(&temp_path, path).map_err(|_| {
        let _ = std::fs::remove_file(&temp_path);
        SlidraError::invalid(format!("failed to write presentation file: {display}"))
    })
}

/// Creates a brand-new deck at `path` and populates it with every entry in
/// `files` (a "relative path -> bytes" map) plus the always-present
/// `container::REQUIRED_DIRS` rows — the one deck-population routine
/// shared by `commands::new` (an author-facing blank presentation) and
/// `build_deck_from_files` (a legacy-ZIP migration's already-read
/// content), so the two can never drift on how a file's ancestor
/// directories get created.
pub fn create_new_with_files(
    path: &Path,
    files: &std::collections::BTreeMap<String, Vec<u8>>,
) -> SlidraResult<()> {
    let conn = create_new(path)?;
    let display = path.display().to_string();
    for &dir in crate::container::REQUIRED_DIRS.iter() {
        insert_dir_row(&conn, dir, &display)?;
    }
    for (file_path, bytes) in files {
        ensure_ancestor_dirs(&conn, file_path, &display)?;
        conn.execute(
            "INSERT INTO content (path, kind, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![file_path, KIND_FILE, bytes],
        )
        .map_err(|_| {
            SlidraError::invalid(format!("failed to write presentation file: {display}"))
        })?;
    }
    Ok(())
}

/// Builds a brand-new deck at `path` from a legacy ZIP's already-validated
/// "relative path -> bytes" map, bumping `project.json`'s own
/// `formatVersion` field to the crate's current value (the container's
/// `user_version` pragma and the JSON field must agree, since every
/// subsequent read goes through `project::validate_project_json`, which
/// checks the JSON field). Every other file's bytes are copied verbatim.
fn build_deck_from_files(
    path: &Path,
    files: &std::collections::BTreeMap<String, Vec<u8>>,
) -> SlidraResult<()> {
    let display = path.display().to_string();
    let mut bumped = files.clone();
    if let Some(project_json) = bumped.get("project.json") {
        bumped.insert(
            "project.json".to_string(),
            bump_format_version(project_json, &display)?,
        );
    }
    create_new_with_files(path, &bumped)
}

fn bump_format_version(bytes: &[u8], display: &str) -> SlidraResult<Vec<u8>> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| SlidraError::invalid(format!("presentation file is corrupted: {display}")))?;
    let obj = value.as_object_mut().ok_or_else(|| {
        SlidraError::invalid(format!("presentation file is corrupted: {display}"))
    })?;
    obj.insert(
        "formatVersion".to_string(),
        serde_json::Value::from(crate::presentation::FORMAT_VERSION),
    );
    Ok(crate::workspace::project::serialize_project_json(obj).into_bytes())
}

fn insert_dir_row(conn: &Connection, path: &str, display: &str) -> SlidraResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO content (path, kind, data) VALUES (?1, ?2, NULL)",
        rusqlite::params![path, KIND_DIR],
    )
    .map_err(|_| SlidraError::invalid(format!("failed to write presentation file: {display}")))?;
    Ok(())
}

/// Ensures every ancestor directory of `virtual_path` has an explicit
/// `kind = 1` row — the SQLite-backed equivalent of the old
/// `std::fs::create_dir_all(parent)` a raw-filesystem write used to do
/// implicitly.
pub(crate) fn ensure_ancestor_dirs(
    conn: &Connection,
    virtual_path: &str,
    display: &str,
) -> SlidraResult<()> {
    let segments: Vec<&str> = virtual_path.split('/').filter(|s| !s.is_empty()).collect();
    let mut prefix = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(segment);
        insert_dir_row(conn, &prefix, display)?;
    }
    Ok(())
}

/// Test-only deck-building helper, shared by every module whose tests used
/// to build a fake "work directory" out of real files on disk
/// (`virtual_fs`, `write`, `history`, `workspace::fonts`, command handler
/// tests, ...) — now builds a real SQLite deck file instead, so those
/// fixtures exercise the same read/write path production code does. Every
/// listed file's ancestor directories, plus the three always-present
/// `container::REQUIRED_DIRS`, get explicit rows automatically.
#[cfg(test)]
pub(crate) fn build_test_deck(label: &str, files: &[(&str, &[u8])]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "slidra-test-deck-{label}-{}.slidra",
        crate::id::random_hex_suffix()
    ));
    let conn = create_new(&path).expect("test deck creation must succeed");
    for &dir in crate::container::REQUIRED_DIRS.iter() {
        insert_dir_row(&conn, dir, "test").expect("test deck dir row must succeed");
    }
    for (file_path, bytes) in files {
        ensure_ancestor_dirs(&conn, file_path, "test")
            .expect("test deck ancestor dirs must succeed");
        conn.execute(
            "INSERT INTO content (path, kind, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![file_path, KIND_FILE, bytes],
        )
        .expect("test deck file insert must succeed");
    }
    path
}

/// Test-only: adds an explicit, empty directory row to an already-built
/// test deck — for a fixture that needs to prove a directory exists
/// independent of any file inside it (e.g. `assets/data/` before its first
/// CSV import, `workspace::mod`'s documented pre-existing gap: that
/// directory is never pre-created by `new`, so the first import into it
/// errors unless a test fixture creates it explicitly first, same as the
/// pre-SQLite version's `create_dir_all` would have).
#[cfg(test)]
pub(crate) fn add_test_dir(deck_path: &std::path::Path, dir: &str) {
    let conn = Connection::open(deck_path).expect("test deck must open");
    insert_dir_row(&conn, dir, "test").expect("test dir row must succeed");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "slidra-test-deck-{label}-{}.slidra",
            crate::id::random_hex_suffix()
        ))
    }

    #[test]
    fn detect_format_reports_not_found_for_a_missing_path() {
        let path = temp_path("missing");
        let err = detect_format(&path).unwrap_err();
        assert!(err.message().contains("presentation file not found"));
    }

    #[test]
    fn detect_format_recognizes_a_freshly_created_deck_as_sqlite() {
        let path = temp_path("fresh");
        create_new(&path).unwrap();
        assert_eq!(detect_format(&path).unwrap(), ContainerFormat::Sqlite);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn open_connection_rejects_an_unrelated_sqlite_file() {
        let path = temp_path("foreign");
        let conn = Connection::open(&path).unwrap();
        conn.execute("CREATE TABLE t (x INTEGER)", []).unwrap();
        drop(conn);
        let err = open_connection(&path).unwrap_err();
        assert!(err.message().contains("presentation file is corrupted"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn open_connection_rejects_a_future_version() {
        let path = temp_path("future");
        {
            let conn = create_new(&path).unwrap();
            conn.pragma_update(None, "user_version", 999i64).unwrap();
        }
        let err = open_connection(&path).unwrap_err();
        assert!(err.message().contains("newer version"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn create_new_overwrites_an_existing_file() {
        let path = temp_path("overwrite");
        std::fs::write(&path, b"not a deck").unwrap();
        create_new(&path).unwrap();
        assert_eq!(detect_format(&path).unwrap(), ContainerFormat::Sqlite);
        std::fs::remove_file(&path).ok();
    }

    /// Merged from the pre-SQLite `container.rs`'s
    /// `pack_and_unpack_round_trips_content_exactly` (Plan §6's test
    /// inventory): a deck's content survives exactly, read back through the
    /// same public API `commands::new`/`commands::open` build on.
    #[test]
    fn deck_round_trips_content_exactly() {
        let path = temp_path("round-trip");
        let files: std::collections::BTreeMap<String, Vec<u8>> = [
            ("project.json".to_string(), b"{\"a\":1}".to_vec()),
            ("slides/001.svg".to_string(), b"<svg/>".to_vec()),
            ("assets/photo.png".to_string(), vec![0x89, 0x50, 0x4e, 0x47]),
        ]
        .into_iter()
        .collect();
        create_new_with_files(&path, &files).unwrap();

        for (virtual_path, expected) in &files {
            let actual =
                crate::workspace::virtual_fs::read_virtual_file_bytes(&path, virtual_path).unwrap();
            assert_eq!(
                &actual, expected,
                "{virtual_path} did not round-trip exactly"
            );
        }
        std::fs::remove_file(&path).ok();
    }

    /// Merged from `container.rs`'s
    /// `pack_writes_empty_directory_entry_for_dirs_with_no_files` (Plan §6):
    /// `slides/`/`assets/`/`fonts/` exist and list empty even when no file
    /// was ever written under them — the deck-row equivalent of the old
    /// ZIP's explicit empty-directory entries.
    #[test]
    fn empty_required_dirs_survive_a_round_trip() {
        let path = temp_path("empty-dirs");
        create_new_with_files(&path, &std::collections::BTreeMap::new()).unwrap();
        for &dir in crate::container::REQUIRED_DIRS.iter() {
            let entries = crate::workspace::virtual_fs::list_virtual_entries(&path, dir).unwrap();
            assert_eq!(
                entries,
                Vec::<String>::new(),
                "{dir} must exist and be empty"
            );
        }
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn migrate_legacy_zip_in_place_is_a_no_op_on_an_already_sqlite_deck() {
        let path = temp_path("already-sqlite");
        create_new(&path).unwrap();
        let before = std::fs::read(&path).unwrap();
        migrate_legacy_zip_in_place(&path).unwrap();
        let after = std::fs::read(&path).unwrap();
        assert_eq!(before, after);
        std::fs::remove_file(&path).ok();
    }
}
