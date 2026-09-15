# A deck is a database, not an archive

> Supersedes ADR-0003's container-format and hidden-work-directory claims (see ADR-0003's own superseded banner). `spec/rfcs/0001-sqlite-container-format.md` is the normative technical spec for the schema, migration mechanics, concurrency, and write-granularity guarantees this ADR only motivates; `docs/spec/slidra-format.md` §1 is the normative on-disk format reference. This ADR is the decision record: what was traded away, and why it was accepted anyway.

ADR-0003 chose "a `.slidra` is a ZIP that `open` unpacks to `~/.slidra/work/<id>/`, edited there, and repacked on save" — the same model Keynote and LibreOffice use. In production it cost more than it bought:

- **`pack`ing a whole deck to save one keystroke.** Every `slides/`, `assets/`, `fonts/` entry gets recompressed on save, even when one slide's text changed. A deck with an embedded video means tens of megabytes rewritten for a one-line edit.
- **A second, full copy of the deck's content exists for as long as it's open**, in `~/.slidra/work/<id>/` — nothing reclaims it except a `pack` or a process exit racing a crash.
- **The file on disk is stale the instant `open` runs.** Every edit lands in the hidden copy; what the author can see, copy, or back up reflects nothing until the next explicit save.

None of these are a tuning problem with the ZIP path — they are consequences of "unpack, edit a copy, repack" as the storage model itself.

## Decision: a `.slidra` file is a single SQLite database, edited in place

`work/<id>/` disappears entirely. There is no more hidden copy: the presentation's content lives, at every moment, in the one file the author already has on disk — literally the meaning of "the deck file is the workspace." A `formatVersion` 5 file's entries are rows in one `content` table (`path TEXT UNIQUE, kind, data BLOB`) — `project.json`, every `slides/00N.svg`, every asset, font, template, and `plan/` file — with directories as explicit rows rather than a prefix derived from the files under them, so an existing-but-empty directory (`ls` → `[]`) stays distinguishable from one that was never created (`ls` → `NotFound`). A legacy ZIP (`formatVersion` 1–4) is migrated to this format exactly once, the first time `slidra open` sees it (`docs/spec/slidra-format.md` §2.7); `formatVersion`/the container's own `user_version` pragma jumps from 4 straight to 5 to mark a container-format change, not a continuation of the old 1→2→3→4 numbering — a version-5 file is never a ZIP, and a 1-through-4 file is never SQLite.

## Why WAL was rejected

`journal_mode = DELETE`, the SQLite default, is set explicitly rather than left to chance — and deliberately not `WAL`. A rollback journal exists only for the duration of one write transaction and is unlinked the instant that transaction commits, so "the deck's directory holds exactly one file once every process has closed it" is a structural guarantee of the journal mode itself, nothing this crate has to remember to clean up on exit or after a crash. WAL would instead leave `-wal`/`-shm` siblings that only an explicit `PRAGMA wal_checkpoint(TRUNCATE)` removes — not exception-safe against a process that dies mid-command. WAL's actual selling point, readers never blocking a writer, buys nothing here either: cross-process concurrency is already serialized by the per-deck advisory lock (`workspace::lock`) before any connection is opened, and within one process only one command ever runs at a time (`crates/slidra/src/deck.rs`'s module docstring).

## Virtual files vs. side data

Not everything living inside the SQLite file is part of the deck's addressable content. The `content` table is the **virtual tree** — every path `ls`/`cat`/`extract` can see and enumerate: `project.json`, `slides/**`, `assets/**`, `fonts/**`, `templates/**`, `plan/**`. Alongside it, in the same file, three further tables (`history_group`/`history_entry`/`history_snapshot`, [E6.T6]) and one more (`chat_history`, [E6.T7]) hold **side data**: undo/redo history and conversation history respectively. Neither is a `content` row, neither is covered by `user_version`/`application_id`, and neither is walkable through the virtual filesystem the CLI exposes to an agent — they exist purely so that copying the deck file carries them with it (`docs/spec/slidra-format.md` §1.4, §1.5), the same mechanism that makes the container a single self-contained file at all. A deck's `owner` field, by contrast, is **not** side data in this sense — it is an ordinary field on the `project.json` row itself (`deck meta set --owner`, `commands::deck`), part of the virtual tree like `name` or `canvas`; see ADR-0023.

## Considered Options

- **Keep the ZIP, tune the packing path** (delta-repack only changed entries, or memory-map the archive): does not remove the second full copy in `work/<id>/`, and a ZIP's central directory still has to be rewritten on most structural changes — it narrows the cost, it does not remove the model that causes it.
- **A directory-based container (no archive at all — the folder itself is the `.slidra`)**: drops "one file" entirely, the property ADR-0002 (users expect a presentation to be one file they can copy, send, back up) was written to protect.
- **SQLite as an ordinary rowid table, `content(path, kind, data)`** (chosen): a large embedded BLOB (a video) must never be forced into an index page — `WITHOUT ROWID` would cluster the whole row by its primary key and put multi-megabyte payloads directly in the btree an ordinary rowid table keeps out of; SQLite's own overflow-page mechanism keeps a large BLOB's pages separate from the row's metadata instead, which is what makes editing one slide cost an amount of data unrelated to the deck's total size.

## Consequences

- **Inspectability is reduced, and that cost is real, not hidden.** A `.slidra` file can no longer be opened with `unzip`, Archive Utility, or any general-purpose ZIP tool — the README's own "makes the deck inspectable" claim now means inspectable *through the CLI* (`ls`, `cat`), or via `slidra extract`/a SQLite client for a full dump, not by a person double-clicking the file in a file manager. This is a genuine reduction from what ADR-0003's container offered, accepted in exchange for the properties above.
- `pack`ing a deck to its own path is a true no-op: the content is already there, nothing is copied, nothing is recompressed.
- Editing one slide writes an amount of data unrelated to the deck's total size (measured directly in `tests/cli_golden.rs`, page-by-page byte comparison — not a proxy like elapsed time).
- Two `slidra` processes writing the same deck concurrently are serialized by the pre-existing per-deck advisory lock, unchanged in mechanism by this ADR; SQLite's own locking is a second, redundant layer underneath it.
- `slidra extract <id-or-path> <dir>` is the named escape hatch (foreshadowed by ADR-0004, built here): it writes every virtual path out as plain real files, for an author who wants their content outside the container entirely.
