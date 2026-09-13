# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Moved the spec docs into `docs/spec/` (the path the CLI spec, tests, and ADRs already referenced): `.dev_docs/spec/cli.md` → `docs/spec/cli.md`, `.dev_docs/spec/slidra-format.md` → `docs/spec/slidra-format-impl.md` (implementation reference), `docs/slidra-format.md` → `docs/spec/slidra-format.md` (public spec). Updated cross-references in ADRs, `.dev_docs/multi-element-addressing.md`, and `verify-setup.md`.
- Moved `quick_start.sh` to `scripts/quick_start.sh` (`npm run verify:setup` updated; docs and QA docs updated to match).
- Moved `docs/qa_report.html` to `qa/`.
- Fixed `commands-reference.test.ts` to match command names with word boundaries, so the short `ls` command no longer false-positives on English words like "list".

## [0.1.0] - 2026-09-XX

### Added

- Initial public release. Renamed from internal project CoMotion.
