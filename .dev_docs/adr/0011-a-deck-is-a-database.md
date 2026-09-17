# ADR-0011 — A deck is a database, not an archive

*Status: in force.*

The original model was an archive unpacked into a hidden working directory, edited there, and
repacked on save — the pattern several desktop suites use. In production it cost more than it
returned.

**Decision.** The deck file is a single database, edited in place. There is no hidden working
copy. The file the person holds *is* the workspace, literally.

**Rejected.** Keeping the archive and tuning the repack — incremental repacking, memory
mapping. It shrinks the cost without removing what causes it: a second complete copy on disk
for as long as the deck is open, and a file that is stale from the moment it is opened.

Also rejected: a folder as the container, which abandons the single-file property the format
exists to protect.

**Consequences.**
- **Inspectability drops, and this is a real regression.** The file can no longer be opened
  with a generic archive tool. It is inspectable through the CLI, or by exporting it.
- Editing one slide writes an amount of data unrelated to the deck's total size. This is the
  property the whole decision was bought for, and it is worth measuring in tests rather than
  assuming.
- Saving to the file's own path is genuinely nothing: the content is already there.
- Undo history and conversation history live in the same file without being part of the deck's
  addressable content, so copying the file carries them along.

*Schema, migration and concurrency guarantees are in `docs/spec/deck-format.md`.*
