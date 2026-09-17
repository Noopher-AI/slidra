# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Rewrote the decision records: 23 records replaced by 12 under `.dev_docs/adr/`, one decision per record, with the volatile half (formats, command sets, gate details) moved to `docs/spec/`. `.dev_docs/CONTEXT.md` was rewritten to match. Every citation elsewhere in the docs and code was remapped to the new numbering; citations to records the rewrite dissolved were dropped, leaving the sentence they annotated intact. The old-to-new map lives in `.dev_docs/adr/README.md`.
- Split `packages/web/src/canvas.ts` into seven modules under `packages/web/src/canvas/`, keeping `canvas.ts` as the entry point with an unchanged exported surface. Four are stateless helpers; three are `create*(deps)` factories reachable only through a named dependency interface. Added `scripts/verify_refactor.sh`, which verifies a move by sorted-diff equality and a rename by reverse substitution, plus the AGENTS.md section on why green tests do not show that a refactor was faithful.
- On macOS, the agent now refuses to start on a PATH the sandbox wrapper's own prelude cannot be resolved on, naming the missing directory in the server log instead of failing as a silent timeout. The e2e suites' deliberately narrowed PATH now includes `/usr/bin:/bin` for the same reason.
- **`.slidra` container format is now SQLite (`formatVersion` 5), not a ZIP unpacked to a hidden work directory** (`spec/rfcs/0001-sqlite-container-format.md`). `slidra open` edits the file in place, migrating a legacy ZIP (`formatVersion` 1–4) to SQLite exactly once; `~/.slidra/work/` is never created. Editing one slide writes an amount of data unrelated to the deck's total size, and closing a deck leaves exactly one file in its directory. Added `slidra extract <id-or-path> <dir>`, the escape hatch back to plain files on disk. `packages/server`'s registry entry field is renamed `workDir` → `deckPath` to match.
- Added private vulnerability-reporting guidance and automated dependency update configuration.
- Clarified `CONTRIBUTING.md`'s open-source/commercial scope: the commercial edition is named Slidra Pro (previously written as "Noopa"), and local execution belongs to this repo without exception — the commercial edition is hosted, and its desktop app runs nothing locally.
- Consolidated the deck format into the authoritative `docs/spec/slidra-format.md`, and moved the separate local-runtime contract to `docs/spec/workspace.md`. Updated the CLI references so `SLIDRA_HOME`, history, and `savedAt` point at the workspace contract.
- Moved `quick_start.sh` to `scripts/quick_start.sh` (`npm run verify:setup` updated; docs and QA docs updated to match).
- Moved the Visual QA protocol and report into `qa/`, and moved agent-skill acceptance fixtures from the root `fixtures/` directory to `qa/fixtures/skills/`.
- Restored the design-token contract under `.dev_docs/design/`, the internal documentation location used by the web token tests and styles.
- Fixed `commands-reference.test.ts` to match command names with word boundaries, so the short `ls` command no longer false-positives on English words like "list".
- Upgraded Vitest and Vite and overrode transitive minimatch to resolve critical and high-severity security advisories.
- Migrated the test projects to Vitest 5 and cleared the remaining moderate npm audit findings.
- Updated React, React DOM, and their TypeScript definitions together to 19.3.0.
- Updated the Rust CLI HTTP client to ureq 3.4.1.
- Updated the ACP TypeScript SDK to 1.4.0 and migrated model switching and connection-close handling.

## [0.1.0] - 2026-09-XX

### Added

- Initial public release. Renamed from internal project CoMotion.
