# Changelog

All notable changes to the `.slidra` format and this repository. The format's own version is `formatVersion` in `project.json`; every change below keeps decks at formatVersion 5 and is backward compatible unless it says otherwise.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Format and playback

- JSON Schemas for `project.json` and the slide vocabulary (`spec/schema/`). Durations are plain decimals (`1e3`, `0x10` and `Infinity` are invalid).
- Document metadata in `project.json`: `author`, `created`, `modified`, `description`, `keywords`, `cover`.
- Accessibility (format §4.7): `<title>`/`<desc>` names, `data-slidra-decorative`, `lang`/`xml:lang`, reading order, and what a reader derives for text, charts, tables and media.
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

### Tools

- `slidra-validate`, a validator for decks.
- `lib/writer/`, the reference writer: build, edit in place, and convert legacy ZIP decks.

### Fixed

- A delayed entrance flashed at full opacity before it started.
- The deck readers could throw raw `RangeError`s and `TypeError`s on damaged files, and a ZIP entry could inflate beyond its declared size.

### Development

- ESLint, Prettier, type checking (`npm run check`), Playwright browser tests, unit tests for slide preparation, frames and the runtime clock, and mutation fuzzing.

## 0.1.0

- The open `.slidra` format (formatVersion 5, SQLite container) and a Next.js viewer that plays it.
