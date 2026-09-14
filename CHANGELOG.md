# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Added private vulnerability-reporting guidance and automated dependency update configuration.
- Consolidated the deck format into the authoritative `docs/spec/slidra-format.md`, and moved the separate local-runtime contract to `docs/spec/workspace.md`. Updated the CLI references so `SLIDRA_HOME`, history, and `savedAt` point at the workspace contract.
- Moved `quick_start.sh` to `scripts/quick_start.sh` (`npm run verify:setup` updated; docs and QA docs updated to match).
- Moved the Visual QA protocol and report into `qa/`, and moved agent-skill acceptance fixtures from the root `fixtures/` directory to `qa/fixtures/skills/`.
- Restored the design-token contract under `.dev_docs/design/`, the internal documentation location used by the web token tests and styles.
- Fixed `commands-reference.test.ts` to match command names with word boundaries, so the short `ls` command no longer false-positives on English words like "list".
- Upgraded Vitest and Vite and overrode transitive minimatch to resolve critical and high-severity security advisories.
- Migrated the test projects to Vitest 5 and cleared the remaining moderate npm audit findings.
- Updated React, React DOM, and their TypeScript definitions together to 19.3.0.

## [0.1.0] - 2026-09-XX

### Added

- Initial public release. Renamed from internal project CoMotion.
