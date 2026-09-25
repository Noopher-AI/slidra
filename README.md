<h1 align="center">Slidra</h1>

<p align="center">
  <b>The open <code>.slidra</code> presentation format — and a viewer that plays it.</b><br>
  <a href="README.zh-TW.md">繁體中文</a>
</p>

A `.slidra` file is one self-contained presentation: SVG slides, their animations and page transitions, speaker notes, media and fonts, stored as rows of a single SQLite database. This repository holds:

- **The specification** — [`spec/slidra-format.md`](spec/slidra-format.md) (what a deck *is*), [`spec/playback.md`](spec/playback.md) (how a deck *plays*), and [`spec/rfcs/0001-sqlite-container-format.md`](spec/rfcs/0001-sqlite-container-format.md) (why the container is SQLite).
- **A viewer** — open a `.slidra` file in your browser and present it, animations included. No build step, no dependencies, nothing uploaded.

Why open the format, and why SVG: [Why We Are Opening the `.slidra` Format](docs/why-open-the-slidra-format.md).

The Slidra editor, the `slidra` CLI, the agent integration and its harness belong to Slidra Pro and are not part of this repository. Decks produced by Slidra Pro play here unchanged.

## Quick start

Requires Node.js 18 or newer. No `npm install` is needed.

```bash
npm start            # or: node server.js
```

Open **http://localhost:8080/** and either pick one of the example decks, click **Choose a .slidra file**, or drag a file onto the page.

Serve your own decks by pointing the server at directories or files:

```bash
node server.js ~/Presentations talk.slidra --port 8080
```

| Option | Default | |
|---|---|---|
| `[paths…]` | `./decks` and `./examples` | Directories (searched 3 levels deep) or `.slidra` files to list on the home page |
| `--port`, `PORT` | `8080` | |
| `--host`, `HOST` | `127.0.0.1` | Use `0.0.0.0` to share on your network |

A deck can be linked directly: `http://localhost:8080/?deck=/decks/1/showcase.slidra#3` opens the showcase at slide 3.

## Presenting

| Key | Action |
|---|---|
| `→` `↓` `Space` `PageDown` `Enter`, click, swipe left | Next step / next slide |
| `←` `↑` `PageUp` `Backspace`, swipe right | Previous step / previous slide |
| `Home` / `End` | First slide / end of the last slide |
| `G` (or `O`) | Overview of all slides |
| `N` | Speaker notes |
| `F` | Fullscreen |
| `Esc` | Close overview → leave fullscreen → close the deck |

What plays: all 14 effects of the five effect families (enter, emphasis, exit, motion path, media) with `on-click` / `with-previous` / `after-previous` timing, per-slide page transitions (fade, slide, zoom), embedded fonts, video and audio, YouTube embeds, charts and tables, dynamic text (`{{ slide_number }}`, `{{ slide_total }}`, `{{ presentation_name }}`) and speaker notes. Both the current SQLite container (format 5) and legacy ZIP decks (format 1–4) open.

## How it works

```
server.js            zero-dependency static server: the viewer, /api/decks, deck bytes
public/
  index.html, app.css
  js/sqlite-reader.js   read-only SQLite file-format reader (b-trees, records, overflow pages)
  js/zip-reader.js      read-only ZIP reader for legacy decks
  js/deck.js            opens a deck, validates project.json, inlines entries as data: URLs
  js/effects.js         effect & transition validation, step derivation (pure, unit-tested)
  js/slide.js           per-slide preparation: dynamic text, play plan, asset inlining
  js/frame.js           the sandboxed srcdoc documents slides render in
  js/player-runtime.js  runs inside each slide frame: steps, Web Animations, media
  js/player.js          the host: page transitions, navigation, embeds
  js/app.js             home page and presenter UI
spec/                the format and playback specifications
examples/            example decks (tools/build-examples.mjs rebuilds them)
test/                unit tests (node --test)
```

The deck is parsed **entirely in the browser**: the server only hands out bytes, and a file you drop onto the page never leaves your machine.

Slide content is treated as untrusted. Each slide renders in an `<iframe sandbox="allow-scripts">` with an opaque origin and a Content-Security-Policy that admits only the viewer's own runtime by nonce, so a slide's own scripts, event handlers and `javascript:` URLs never run, and it cannot reach the viewer page. Deck-local assets are inlined as `data:` URLs, so a self-contained deck makes no network requests at all.

## Development

```bash
npm test                  # unit tests: SQLite reader (cross-checked against node:sqlite), ZIP reader, deck & effect validation
npm run examples          # rebuild examples/ (Node ≥ 22.5 for node:sqlite)
```

The code is plain ES modules with no build step; edit and reload.

## License

MIT — see [LICENSE](LICENSE). The example deck embeds a subset of Noto Sans TC under the SIL Open Font License 1.1 (its licence text travels inside the deck at `fonts/LICENSE-NotoSansTC.txt`).
