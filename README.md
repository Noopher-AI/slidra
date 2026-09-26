<h1 align="center">Slidra</h1>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://slidra-demo.vercel.app/"><img alt="Deployed on Vercel" src="https://img.shields.io/badge/demo-Vercel-000000?logo=vercel&logoColor=white"></a>
  <a href="https://nextjs.org/"><img alt="Built with Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white"></a>
</p>

<p align="center">
  <b>The open <code>.slidra</code> presentation format — and a viewer that plays it.</b><br>
  <a href="README.zh-TW.md">繁體中文</a>
</p>

A `.slidra` file is one self-contained presentation: SVG slides, their animations and page transitions, speaker notes, media and fonts, stored as rows of a single SQLite database. This repository holds:

- **The specification** — [`spec/slidra-format.md`](spec/slidra-format.md) (what a deck *is*), [`spec/playback.md`](spec/playback.md) (how a deck *plays*), [`spec/rfcs/0001-sqlite-container-format.md`](spec/rfcs/0001-sqlite-container-format.md) (why the container is SQLite), and JSON Schemas for `project.json` and the slide vocabulary under [`spec/schema/`](spec/schema/).
- **A viewer** — open a `.slidra` file in your browser and present it, animations included. Built with Next.js; nothing is uploaded.

Why open the format, and why SVG: [Why We Are Opening the `.slidra` Format](docs/why-open-the-slidra-format.md).

The Slidra editor, the `slidra` CLI, the agent integration and its harness belong to Slidra Pro and are not part of this repository. Decks produced by Slidra Pro play here unchanged.

## Quick start

The viewer is a Next.js app. Requires Node.js 20.9 or newer.

```bash
npm install
npm run dev          # or: npm run build && npm start
```

Open **http://localhost:3000/** and either pick one of the example decks, click **Choose a .slidra file**, or drag a file onto the page.

Serve your own decks by dropping them into `decks/`, or by listing directories and files in `SLIDRA_DECKS` (separated by `:`):

```bash
SLIDRA_DECKS=~/Presentations:talk.slidra npm run dev -- --port 8080
```

| Setting | Default | |
|---|---|---|
| `SLIDRA_DECKS` | `decks:examples` | Directories (searched 3 levels deep) or `.slidra` files to list on the home page |
| `--port`, `PORT` | `3000` | |
| `--hostname` | all interfaces | |

A deck can be linked directly: `http://localhost:3000/?deck=/decks/1/showcase.slidra#3` opens the showcase at slide 3.

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

What plays: all 20 effects of the five effect families (enter, emphasis, exit, motion path, media) with `on-click` / `with-previous` / `after-previous` timing, six easing curves, repeats, text builds by line, word or letter, click triggers on any element, per-slide page transitions (fade, slide, zoom, and morph, which moves elements that share an id from one slide's layout to the next), embedded fonts, video and audio, YouTube embeds, charts and tables, dynamic text (`{{ slide_number }}`, `{{ slide_total }}`, `{{ presentation_name }}`) and speaker notes. Both the current SQLite container (format 5) and legacy ZIP decks (format 1–4) open.

Document metadata from `project.json` (author, dates, description, keywords, cover slide) shows up in the library, in the title bar and at the top of the overview.

Slides are accessible (format §4.7): each slide frame carries the deck's `lang` (or the slide's own `xml:lang`), a slide's `<title>` names it in the overview and to screen readers, element `<title>`s become `aria-label`s (so they never pop up as tooltips mid-talk), and `data-slidra-decorative` elements are hidden from assistive technology.

Elements can be links (format §4.8): `data-slidra-link` opens a web page in a new tab, jumps to another slide by its `data-slidra-slide-id`, or goes `#next` / `#previous` / `#first` / `#last`. Click a linked element or Tab to it and press Enter. Any other kind of URL is ignored.

## How it works

```
app/                 Next.js App Router
  layout.jsx, page.jsx, globals.css
  viewer-shell.jsx      the viewer's markup; boots lib/viewer/app.js on mount
  api/decks/route.js    lists the served decks
  decks/[...path]/      deck bytes
  spec/[...path]/       the specs as plain text
lib/decks.js         server-side deck discovery (SLIDRA_DECKS)
lib/schema.js        compiles spec/schema/ with Ajv (Node only; tests and tools)
lib/viewer/
  sqlite-reader.js      read-only SQLite file-format reader (b-trees, records, overflow pages)
  zip-reader.js         read-only ZIP reader for legacy decks
  deck.js               opens a deck, validates project.json, inlines entries as data: URLs
  effects.js            effect & transition validation, step derivation (pure, unit-tested)
  slide.js              per-slide preparation: dynamic text, play plan, asset inlining
  frame.js              the sandboxed srcdoc documents slides render in
  player.js             the host: page transitions, navigation, embeds
  app.js                home page and presenter UI
public/js/player-runtime.js  runs inside each slide frame: steps, Web Animations, media
spec/                the format and playback specifications; spec/schema/ holds their JSON Schemas
examples/            example decks (tools/build-examples.mjs rebuilds them)
test/                unit tests (node --test)
e2e/                 browser tests (Playwright)
```

The deck is parsed **entirely in the browser**: the server only hands out bytes, and a file you drop onto the page never leaves your machine.

Slide content is treated as untrusted. Each slide renders in an `<iframe sandbox="allow-scripts">` with an opaque origin and a Content-Security-Policy that admits only the viewer's own runtime by nonce, so a slide's own scripts, event handlers and `javascript:` URLs never run, and it cannot reach the viewer page. Deck-local assets are inlined as `data:` URLs, so a self-contained deck makes no network requests at all.

## Development

```bash
npm test                  # unit tests: SQLite reader (cross-checked against node:sqlite), ZIP reader, deck & effect validation
npm run examples          # rebuild examples/ (Node ≥ 22.5 for node:sqlite)
npm run lint              # ESLint (flat config in eslint.config.mjs)
npm run format            # Prettier; npm run format:check only reports
npm run typecheck         # TypeScript over the JSDoc-annotated JavaScript (jsconfig.json, checkJs)
npm run check             # lint + format:check + typecheck + unit tests: run before opening a pull request
npm run test:e2e          # browser tests (Playwright, Chromium): playback, navigation, the slide sandbox
```

The browser tests start their own `next dev` on port 3107 (`SLIDRA_E2E_PORT` overrides it). Install the browser once with `npx playwright install chromium`. Test decks are built on the fly by `test/fixtures/make-deck.mjs`.

The viewer core is plain ES modules (`lib/viewer/`) bundled by Next.js; `npm run dev` reloads on save.

## Deployment

The live demo at **https://slidra-demo.vercel.app/** runs on Vercel (project `slidra-demo`).

- `vercel.json` pins the Next.js preset: `npm ci`, then `next build`.
- The example decks in `examples/` and the specs in `spec/` ship inside the route handlers (`outputFileTracingIncludes` in `next.config.mjs`), so the demo lists exactly what is in `examples/`.
- Deploys are made from the CLI, not on push: `vercel link` once, then `vercel deploy --prod`.

## License

MIT — see [LICENSE](LICENSE). The example deck embeds a subset of Noto Sans TC under the SIL Open Font License 1.1 (its licence text travels inside the deck at `fonts/LICENSE-NotoSansTC.txt`).
