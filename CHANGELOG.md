# Changelog

All notable changes to the `.slidra` format and this repository. The format's own version is `formatVersion` in `project.json` (and `PRAGMA user_version`); each release below says which formatVersion it defines.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Viewer

- The player reads a deck through a `DeckSource` (`lib/viewer/source.js`): `project()`, `slide(path)` and `fileUrl(path)`, with optional `slideIds()` and `presenter()`. It fetches only the slides it shows and prepares, and loads fonts and images from the source's URLs, admitted one by one by the slide frame's CSP. `openDeck` and every file-based path play exactly as before (`deckSourceFromBytes`). `<slidra-player>` takes one as its `source` property; `startViewer({ source, presenterUrl })` and `startPresenter({ openSource })` let a page play one in the viewer and its presenter view.

### Tooling

- `npm run bundle` builds `dist/slidra-bundle/` deterministically, for vendoring the format and player at one tag: the viewer library (`player/slidra-viewer.js`, the public API of the new `lib/viewer/index.js`, slide runtime inlined), the viewer's and presenter view's markup and stylesheet, `<slidra-player>`, the slide runtime, a self-contained validator (`validator/slidra-validate.mjs`: `validateDeck` and the CLI, ajv and xmldom bundled), the schemas, the spec, the conformance suite and a `MANIFEST.json` of sizes and sha256s with the source commit. Pushing a `format-v*` tag attaches `slidra-bundle-<tag>.tar.gz` and its `.sha256` to that tag's GitHub release.
- When bundled, `startViewer` and `startPresenter` use the inlined slide runtime instead of fetching `/js/player-runtime.js`. The validator CLI moved to `lib/validate-cli.js`; `bin/slidra-validate.mjs` behaves as before.

## 6.0.0 — formatVersion 6

formatVersion 6 freezes the format as it stands here: the SQLite container of 0.1.0, unchanged, plus everything under *Format and playback* below, including the layout-role vocabulary. A deck says so with `formatVersion` 6 in `project.json` and `PRAGMA user_version` 6.

### Breaking

- **formatVersion 6 is the current format; 5 is legacy** (format §1.2). Writers write 6. Readers may still open a formatVersion 5 (SQLite) or 1–4 (ZIP) deck read-only, and a writer that edits one converts it to 6 once, atomically. Any other version is rejected.
- **The conformance suite covers formatVersion 6 only.** It no longer contains legacy decks: `accept-legacy-zip-v4` and `container-zip-claims-v5` are gone, every other case is rebuilt at formatVersion 6, and `project-format-version-6` (reject) became `project-format-version-7`. New: `project-format-version-0`, and `roles-core`, `roles-extension` and `roles-invalid` for layout roles. A reader that implements only formatVersion 6 passes the whole suite.
- The JSON Schemas' `$id`s move from `https://slidra.app/schema/5/…` to `https://slidra.app/schema/6/…`.

### Format and playback

- JSON Schemas for `project.json` and the slide vocabulary (`spec/schema/`). Durations are plain decimals (`1e3`, `0x10` and `Infinity` are invalid).
- Document metadata in `project.json`: `author`, `created`, `modified`, `description`, `keywords`, `cover`.
- Accessibility (format §4.7): `<title>`/`<desc>` names, `data-slidra-decorative`, `lang`/`xml:lang`, reading order, and what a reader derives for text, charts, tables and media.
- Layout roles (format §4.9): `data-slidra-role` says what an element is for in the layout: `background` (§4.6, unchanged), `field`, `node`, `spine`, `edge`, `label`, `garnish`, or a `<prefix>:<name>` tool extension. Semantic only; readers may ignore roles and writers preserve them.
- Stable slide ids (`data-slidra-slide-id`) and links (`data-slidra-link`: web pages, other slides, `#next`/`#previous`/`#first`/`#last`).
- Effects: `easing`, `repeat`, text builds (`by`, `stagger`), `trigger`, and the `fly-down`, `fly-right` and four `fly-out-*` effects.
- The `morph` page transition.
- The conformance suite (`conformance/`).
- Readers fail safely on hostile containers, and block a deck's network resources until the viewer allows them.
- Recommended presenter keys, the presenter view, printing and export, and assistive-technology announcements with reduced motion (playback §1, §6.1, §8, §9).

### Viewer

- Presenter view in a second window, blackout, go-to-slide, key help, laser pointer and magnifier.
- Print and save as PDF (slides, notes pages, handouts, per-step pages); export slides as PNG or ZIP.
- Link previews (`og:image` from `/api/og`), `/embed` for other sites, and oEmbed.
- `<slidra-player>` web component (`@slidra/player`).
- Screen-reader announcements, keyboard overview, focus-trapped dialogs, reduced motion.
- Large decks: PNG thumbnails and bounded caches.

### Examples

- `motion.slidra` and `sharing.slidra`, feature tours of this round (`tools/build-feature-examples.mjs`).
- Every example deck is rebuilt at formatVersion 6.

### Tools

- `slidra-validate`, a validator for decks.
- `lib/writer/`, the reference writer: build formatVersion 6, edit in place (upgrading a formatVersion 5 deck to 6), and convert legacy decks.
- `slidra-validate` reports a legacy deck (formatVersion 1–5) as a `legacy-format-version` warning, and an invalid layout role as a `role-unknown` error.

### Fixed

- A delayed entrance flashed at full opacity before it started.
- The deck readers could throw raw `RangeError`s and `TypeError`s on damaged files, and a ZIP entry could inflate beyond its declared size.

### Development

- ESLint, Prettier, type checking (`npm run check`), Playwright browser tests, unit tests for slide preparation, frames and the runtime clock, and mutation fuzzing.

## 0.1.0

- The open `.slidra` format (formatVersion 5, SQLite container) and a Next.js viewer that plays it.
