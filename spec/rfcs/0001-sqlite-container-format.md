# RFC 0001: SQLite container format — the deck file is the workspace

Status: accepted, implemented.
Supersedes: ADR-0011's ZIP-and-hidden-work-directory model.
Related: ADR-0003 (real paths never leaked, and the CLI is the only writer
of content; `slidra extract` named there as the escape hatch, ahead of this
RFC actually building it).

## Summary

A `.slidra` file stops being a ZIP that `open` unpacks into
`~/.slidra/work/<id>/` for the duration of an editing session. It becomes a
single SQLite database file, edited **in place**. There is no more hidden
work directory: the presentation's content lives, at every moment, in the
one file the author already has on disk. `formatVersion` (and the
container's own `user_version` pragma) moves from **4** to **5** to mark
this as a different container format, not a continuation of the old
1→2→3→4 chain — a version-5 file is never a ZIP, and a version-1-through-4
file is never SQLite.

## Motivation (GitHub #339 / [E6] "The deck file is the workspace")

The ZIP-plus-work-directory model has three structural costs:

1. **`pack`ing a whole deck to save one keystroke.** `slidra pack`
   recompresses every file in the work directory — `slides/`, `assets/`,
   `fonts/` — even when only one slide changed. For a deck with a large
   embedded video, this means tens of megabytes re-written for a one-line
   text edit.
2. **A second copy of the deck's content always exists while it's open.**
   `~/.slidra/work/<id>/` is a full, uncompressed duplicate of everything
   in the `.slidra` file, for as long as any process has it open. Nothing
   ever cleans it up except a `pack` (or process exit racing a crash).
3. **The `.slidra` file the author has on disk is stale the instant `open`
   runs.** Every edit lands in the hidden copy; the file the author can see,
   copy, or back up reflects nothing until the next explicit save.

None of these are fixable by tuning the ZIP path — they are consequences of
"unpack, edit a copy, repack" as the storage model itself. This RFC
replaces the model, not the tuning.

## 1. Container format

A `.slidra` v5 file is a SQLite database with one table:

```sql
CREATE TABLE content (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    kind INTEGER NOT NULL,   -- 0 = file, 1 = directory
    data BLOB                -- NULL for a directory row
)
```

Every virtual path the old real-directory tree could have — `project.json`,
`slides/001.svg`, `assets/photo.png`, an explicitly-created but currently
empty `assets/data/` — is one row. A **directory is an explicit row**, not
a prefix derived from the files under it: this is what lets `ls` on an
existing-but-empty directory answer `[]` (a fact about the presentation)
while `ls` on a directory that was never created answers `NotFound` (a
distinction the old real-filesystem tree got for free from `mkdir` having
or not having happened, and that an implicit, prefix-derived notion of
"directory" cannot recover).

The header identifies the container without relying on the `.slidra`
extension: `PRAGMA application_id` is set to a fixed constant (ASCII
`Sldr`), and `PRAGMA user_version` is set to the crate's `FORMAT_VERSION`
(5). `open`/`extract` sniff the file's first bytes (`SQLite format 3\0` vs
`PK\x03\x04`) to tell a SQLite deck from a legacy ZIP one — never the file
extension, which is user-controlled and not to be trusted for anything
structural.

**`journal_mode = DELETE`, not WAL.** A rollback journal exists only for
the duration of one write transaction and is unlinked the instant that
transaction commits — "the deck's directory holds exactly one file once
every process has closed it" (Scope item 4) is then a structural property
of the journal mode itself, nothing this crate has to remember to clean up
on exit or after a crash. WAL would instead leave `-wal`/`-shm` siblings
that only an explicit `PRAGMA wal_checkpoint(TRUNCATE)` removes — not
exception-safe against a process that dies mid-command, and WAL's actual
selling point (readers never blocking a writer) buys nothing here: cross
process concurrency is already serialized by the per-deck advisory lock
(§3) before any connection is opened, and within one process only one
command ever runs. `synchronous = FULL` and `busy_timeout = 5000` are set
alongside it.

**Content, not `WITHOUT ROWID`.** A large BLOB (an embedded video) must
never be forced into an index page — `WITHOUT ROWID` clusters the whole row
by its primary key, which would put multi-megabyte payloads directly in the
btree an ordinary rowid table keeps out of. `content` is an ordinary rowid
table with a `UNIQUE` index on `path`; SQLite's own overflow-page mechanism
keeps a large BLOB's pages separate from the row's own metadata, which is
what makes Scope item 5 (below) achievable at all.

## 2. Migration (Scope item 1: no migration for the SQLite format itself)

A legacy ZIP (`formatVersion` 1 through 4) is migrated to SQLite exactly
once, the moment `slidra open` sees it, and never again:

1. Every file is read out of the ZIP into memory, validated the same way
   the old unpacker validated it (a parseable `project.json` at one of the
   legacy versions, no path-traversal entry, no slide SVG still carrying
   the old CoMotion namespace marker).
2. A brand-new SQLite deck is built **at a sibling temp path**
   (`<name>.slidra.migrating-<hex>`, same directory) — `slides/`, `assets/`,
   `fonts/` inserted as directory rows even when empty, then every file
   inserted, with `project.json`'s own `formatVersion` field bumped to 5 (the
   container's `user_version` and the JSON field must agree, since every
   later read validates the JSON field independently).
3. Only once that temp file is completely and successfully written does an
   atomic same-directory `rename` replace the original. Any failure before
   that rename removes the temp file and leaves the original **untouched,
   byte-for-byte** — migration is one-way, but a failed attempt is not a
   partial one.

There is no SQLite-to-SQLite migration chain: version 5 is the only version
this crate has ever produced, and the jump from 4 straight to 5 (not "5"
meaning "the fifth revision of the same numbering") marks a container
format change, not a schema evolution within one format.

Idempotence falls out of the design rather than needing separate handling:
`migrate_legacy_zip_in_place` checks the file's header first and is a no-op
on an already-SQLite file, so `open`ing the same deck twice never
re-migrates, and there is never a moment where two migration attempts race
each other on the same file (the per-deck lock, §3, is already held by the
time migration would run).

## 3. Concurrency (Scope item 6)

Two `slidra` processes writing the same deck concurrently must not corrupt
it, and the existing parallel-effect-add test must keep passing unchanged.
This is enforced above the SQLite layer, not by it: `workspace::lock`'s
per-deck advisory lock file, at
`<SLIDRA_HOME>/locks/<fnv1a64(canonical deck path)>.lock`, is acquired once
in `main.rs` and held for the process's entire lifetime — the same
lock-for-the-whole-command design the old per-work-directory `.slidra.lock`
used, relocated because the lock can no longer live *inside* the thing it
protects (Scope item 4 requires the deck's directory to hold exactly one
file; a coordination file living beside the deck would violate that the
moment two processes raced).

The lock is keyed by the deck's **canonical file path**, not by
presentation id: two different ids can resolve to the same underlying file
(`open`ing one path twice mints two ids that both point at it), and both
must still serialize against each other. Hashing the id would miss that
case entirely.

SQLite's own locking (`journal_mode=DELETE`'s exclusive lock during commit,
`busy_timeout=5000`) is a second, independent layer underneath the advisory
lock — belt and suspenders, not the primary mechanism, since the advisory
lock already prevents two `slidra` processes from ever having the deck open
for writing at the same moment.

## 4. Write granularity (Scope item 5)

Editing one slide must write an amount of data unrelated to the deck's
total size — specifically, under 1 MB even when the deck embeds a 20 MB
video. This holds because:

- Content is a plain rowid table (§1): updating one row's `data` BLOB only
  touches that row's own pages plus whatever btree-balancing a same-size-or-
  smaller write requires — it never touches an unrelated row's pages.
- `journal_mode=DELETE` copies only the pages a transaction is about to
  modify into the rollback journal before writing them — not the whole
  file — so the journal's own write volume scales with the edit, not the
  deck.
- No operation in the edit path ever runs `VACUUM` or otherwise rewrites
  the file wholesale. `pack`ing to the deck's own path is explicitly a
  no-op (§5) for the same reason: there is nothing to copy.

Measured directly in `tests/cli_golden.rs`'s
`editing_one_slide_writes_under_1mb_even_with_a_20mb_asset`: page-by-page
(4096-byte pages) comparison of the deck file's bytes before and after a
single `slide notes set`, not a proxy like elapsed time.

## 5. `open`/`pack`/`extract` semantics

**`open <path>`** no longer copies anything. It migrates `path` in place if
needed (§2) and registers a fresh id pointing directly at `path` itself —
`path` **is** the presentation's content from that point on, the same file
`pack`ing back to it will later find. Opening the same path twice mints two
independent ids that share one underlying file; an edit made through one id
is immediately visible through the other, since they are the same file —
this is the literal meaning of "the deck file is the workspace," and a
deliberate change from the old copy-per-id model.

**`pack <id> <path>`**: when `path` is the deck's own file, nothing is
copied — the content is already there — and only the registry's `savedAt`
bookkeeping updates (only when `path` also matches the presentation's
remembered *source* path, which can differ from the deck's own path when
`packages/server`'s `reopenPresentationInPlace` has rewritten it
independently). Any other `path` is a plain file copy of the deck's current
bytes, staged then renamed, overwriting whatever was there — no directory
walk, no re-compression, because the deck already *is* the container
format.

**`extract <id-or-path> <dir>`** (new — named in ADR-0003 as the intended
escape hatch, built here): writes every virtual path in a deck out as plain
real files under `dir`, including empty directories. Accepts either an
already-`open`ed id or a raw filesystem path (legacy ZIP or SQLite) not yet
opened, and never migrates or registers anything against a raw path — an
author can extract a `.slidra` they don't want touched. `dir` must not
already exist as a non-empty directory (no overwrite, no merge).

## 6. What this changes elsewhere

- **ADR-0011** (`.slidra` is a ZIP unpacked to `~/.slidra/work/<id>/`) is
  superseded by this RFC for the container format and working-directory
  claims; its claims about `project.json`'s own field shape
  (`formatVersion`/`name`/`canvas`/`slides`/`fonts`) are unaffected.
- **ADR-0003**'s repeated "`work/<id>` remains unreadable outside the CLI"
  invariant is moot rather than violated: there is no `work/<id>` any more
  for that statement to be about. The invariant it was protecting — an
  agent can only reach presentation content through the CLI's virtual
  interface, never a real path — is unchanged, now upheld because the
  content lives inside a SQLite file no ACP file method or shell command
  the agent can reach ever opens directly.
- **`packages/server/src/slidra/home.ts`**'s `SlidraRegistryEntry.workDir`
  becomes `deckPath` (the Rust crate's `RegistryEntry.deck_path` mirrors
  it exactly — the two must never drift, since they read and write the
  same `projects.json`). `workDirFor`/`maxMtimeInDirectory` become
  `deckPathFor`/`deckFileMtime` (a single `stat`, not a directory walk).
- **`packages/server/src/watch.ts`** watches the deck file itself
  (`fs.watch(deckPath)`, non-recursive) instead of the work directory
  recursively, filtering a `-journal` sibling instead of `.slidra.lock`
  (which no longer lives beside the deck at all — see §3).
- **`packages/server/src/open-endpoint.ts`**'s `reopenPresentationInPlace`
  truncates and rewrites the deck file's bytes in place instead of
  swapping a directory's children — `fs.watch(deckPath)` holds a handle on
  that exact inode, and replacing the inode out from under a live `serve`
  watcher would kill it, the same reasoning that kept the old version from
  ever recreating the work directory itself.
