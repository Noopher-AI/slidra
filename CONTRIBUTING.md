# Contributing to Slidra

Thanks for helping. This repository holds the open `.slidra` format (its specification, schemas and conformance suite) and a reference implementation: the viewer, the writer, the validator and the `<slidra-player>` web component. Changes to either are welcome.

## Before you start

- **Bugs**: open an issue with a deck that shows the problem, if you can share one. `npm run validate -- deck.slidra` often says what is wrong.
- **Format changes** (anything that changes what a deck *is* or how it *plays*): open an issue using the *Format change* template first. The spec is the contract that every reader and writer depends on, so it changes on purpose, in the open.
- **Security problems**: do not open an issue. See [SECURITY.md](SECURITY.md).

## Setting up

Node.js 20.9 or newer runs the viewer. The writer, the conformance builder and the fuzzer need Node 22.5 or newer, because they use `node:sqlite`.

```bash
npm install
npx playwright install chromium   # once, for the browser tests
npm run dev                       # the viewer on http://localhost:3000
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | The viewer, reloading on save |
| `npm run build`, `npm start` | Production build and server |
| `npm test` | Unit tests (`test/`, Node's test runner) |
| `npm run test:e2e` | Browser tests (`e2e/`, Playwright, Chromium) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier (`npm run format:check` only reports) |
| `npm run typecheck` | TypeScript over the JSDoc-typed JavaScript |
| `npm run check` | lint, format check, type check and unit tests: run it before every pull request |
| `npm run examples` | Rebuild `examples/` (needs the embedded font and media, see `tools/build-examples.mjs`) |
| `npm run conformance` | Rebuild `conformance/` from `conformance/cases.mjs` |
| `npm run validate -- <deck>` | Check a deck against the spec |
| `npm run fuzz` | A long mutation-fuzzing run of the deck readers |
| `npm run build:element` | Build the `<slidra-player>` bundle into `packages/slidra-player/dist/` |
| `npm run bundle` | Build `dist/slidra-bundle/`, the deterministic bundle for vendoring that each `format-v*` tag releases |

## Making a change

1. **Spec first.** A change to behaviour that the format describes starts in `spec/slidra-format.md` or `spec/playback.md`, together with `spec/schema/` when the vocabulary changes, and gets a conformance case in `conformance/cases.mjs` when readers must agree on it. Then the code follows. Keep the spec change in its own commit.
2. **Tests with every change.** Pure logic gets unit tests. Anything a viewer shows or does gets a browser test in `e2e/`. Fix a bug with a test that fails before the fix.
3. **Keep the readers safe.** Deck bytes and slide content are untrusted (format §17). Never run slide script, never widen the slide frame's sandbox or CSP, and treat every id, attribute and text from a deck as data.
4. **Both READMEs.** User-visible changes go into `README.md` and `README.zh-TW.md`, and into `CHANGELOG.md` under *Unreleased*.
5. **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs(spec):`, `test:`, `perf:`, `refactor:`, `build:`, `chore:`. Write the body to explain why.

## Pull requests

Fill in the template: what changed and why, how you verified it (the exact commands), what remains risky, and how to roll it back. `npm run check` and `npm run test:e2e` must pass.

## Code style

Plain ES modules with JSDoc types, formatted by Prettier with a 200-column width. The slide runtime (`public/js/player-runtime.js`) is an ES5-style classic script on purpose, because it is inlined into every sandboxed slide frame. Match the code around you: its comment density, naming and idioms.

## Licence

By contributing you agree that your contributions are licensed under the [MIT licence](LICENSE).
