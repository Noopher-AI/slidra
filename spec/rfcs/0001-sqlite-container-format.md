# RFC 0001: The SQLite container — the deck file is the workspace

**Status:** accepted, implemented (format version 5)
**Supersedes:** the ZIP container of format versions 1–4

## Summary

A `.slidra` file is a single SQLite database, edited in place. There is no hidden working copy: the presentation's content lives, at every moment, in the one file the author holds. `formatVersion` (and the database's `user_version`) moves from 4 to 5 to mark a different container, not a continuation of the ZIP numbering — a version-5 file is never a ZIP, and a version-1–4 file is never SQLite.

## Motivation

The ZIP model — unpack into a working directory, edit the copy, repack to save — has three structural costs:

1. **Repacking a whole deck to save one keystroke.** Saving recompresses every slide, asset and font even when one slide changed; with a large embedded video, a one-line text edit rewrites tens of megabytes.
2. **A second copy of the deck always exists while it is open**, and nothing but a save (or a crash racing process exit) ever reconciles it.
3. **The file the author sees is stale the moment it is opened.** Every edit lands in the hidden copy; the visible file reflects nothing until the next explicit save.

These are consequences of "unpack, edit a copy, repack" itself, so this RFC replaces the storage model rather than tuning it.

## 1. Schema

```sql
CREATE TABLE content (
    id   INTEGER PRIMARY KEY,
    path TEXT    NOT NULL UNIQUE,
    kind INTEGER NOT NULL,   -- 0 = file, 1 = directory
    data BLOB                -- NULL for a directory row
)
```

Every virtual path the old directory tree could hold is one row. **A directory is an explicit row**, not a prefix derived from the files below it: that is what lets "list an existing but empty directory" answer `[]` while "list a directory that was never created" answers *not found* — a distinction a prefix-derived notion of directory cannot recover.

The header identifies the container without trusting the file extension: `PRAGMA application_id` is `0x536C6472` (ASCII `Sldr`) and `PRAGMA user_version` is `5`. Readers sniff the first bytes (`SQLite format 3\0` versus `PK\x03\x04`) to tell the two containers apart.

**`journal_mode = DELETE`, not WAL.** A rollback journal exists only for the duration of one write transaction, so "the deck's directory holds exactly one file once every process has closed it" is a property of the journal mode itself — nothing to clean up after a crash. WAL would leave `-wal`/`-shm` siblings that only an explicit checkpoint removes, and a WAL file copied without its sibling can lose committed data. WAL's advantage (readers never block the writer) buys nothing when edits are already serialised per deck. Writers also set `synchronous = FULL` and a busy timeout.

**A rowid table, not `WITHOUT ROWID`.** A large BLOB must never be forced into an index page. With an ordinary rowid table and a `UNIQUE` index on `path`, SQLite's overflow pages keep a large payload apart from the row's metadata, which is what makes the write-granularity property below achievable.

## 2. Migration from ZIP

A legacy ZIP deck (format 1–4) is converted exactly once, the first time a writer opens it:

1. Every entry is read into memory and validated (a parseable `project.json` at a legacy version, no path escaping the deck).
2. A new SQLite deck is built at a sibling temporary path, with `slides/`, `assets/`, `fonts/` created as directory rows even when empty, every file inserted, and `project.json`'s `formatVersion` set to 5 (the JSON field and `user_version` must agree).
3. Only when that file is complete does an atomic same-directory rename replace the original. Any failure before the rename deletes the temporary file and leaves the original untouched, byte for byte.

Conversion is idempotent: a writer checks the header first, so opening an already-SQLite deck never converts again. There is no SQLite-to-SQLite migration chain; 5 is the only SQLite version.

Readers that only display a deck (such as this repository's viewer) MAY read a ZIP deck directly without converting it.

## 3. Concurrency

Two writers must never corrupt a deck. Writers serialise on a per-deck advisory lock keyed by the deck's canonical file path (not by any in-memory identifier: two handles can name the same file), held for the whole operation. The lock lives outside the deck's directory, because that directory must hold exactly one file. SQLite's own locking is a second, independent layer underneath.

## 4. Write granularity

Editing one slide writes an amount of data unrelated to the deck's total size — under 1 MB even when the deck embeds a 20 MB video — because:

- updating one row's `data` touches only that row's pages (plus b-tree balancing), never an unrelated row's;
- `journal_mode = DELETE` journals only the pages a transaction modifies;
- nothing in the edit path runs `VACUUM` or rewrites the file wholesale.

## 5. Consequences

- **Saving is not a separate step.** Every edit is already in the file. "Save as" is a plain byte copy of the database.
- **Extraction is explicit.** Turning a deck into loose files is a deliberate export, never part of opening it.
- **The file carries more than the presentation.** Writers may keep other tables beside `content` (undo history, conversation logs). They travel with the file; readers ignore them (format §1.1).
- **Readers need a SQLite reader.** For environments without one, the format is simple enough to read directly: this repository's `public/js/sqlite-reader.js` is a dependency-free, read-only implementation of the parts of the SQLite file format a deck uses (table b-trees, records, overflow pages), in about 250 lines.
