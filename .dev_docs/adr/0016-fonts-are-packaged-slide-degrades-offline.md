# Fonts are packaged with the `.slidra` in `fonts/`; a standalone slide only degrades to system fonts when opened elsewhere

> **This ADR opens an explicit hole in two existing ADRs.** ADR-0003's container structure originally had three directories (`project.json` + `slides/` + `assets/`); this ADR adds a fourth: `fonts/`. ADR-0001 originally required "a static view must render correctly" whenever a single slide is opened in any tool; this ADR carves out an explicit exception for **fonts**: a slide opened on its own degrades to a system font. The rest of both ADRs is unaffected.
>
> The **decision** that fonts are packaged with the `.slidra`, and degrade to system fonts when opened standalone, is unchanged; the complete `FontEntry` field table for `project.json.fonts`, and the precise rule that `fonts` becomes required (`[]` is valid) starting at `formatVersion` 4, along with the 3→4 migration rules, are detailed in
> [`docs/spec/slidra-format.md`](../../docs/spec/slidra-format.md).

A CJK presentation needs a font to measure and render stable, cross-environment-consistent text: the Node side needs it to compute layout without a browser, and the browser needs to render with the exact same font — the widths measured on both sides must agree, or layout will jump between editing and playback. This font can't depend on the user's machine happening to have the right CJK font already installed — so it has to travel with the `.slidra`.

## Decision one: fonts are part of the container's content, registered in `project.json.fonts`

The `.slidra` gets a new `fonts/` directory holding the font file itself (an sfnt/`.ttf`) and the full license text. `project.json` gets a new optional field, `fonts: FontEntry[]`:

```ts
interface FontEntry {
  /** Path relative to the container root, e.g. "fonts/NotoSansTC-Presentation.ttf". */
  file: string;
  /** The value referenced by the SVG font-family attribute; also this font's unique key within the presentation. */
  family: string;
  /** Human-readable license name, e.g. "SIL Open Font License 1.1". */
  license: string;
  /** Path to the full license text, relative to the container root. */
  licenseFile: string;
  /** Where the font came from. */
  source: string;
}
```

**Path rules**: `file` and `licenseFile` must be paths relative to the container root, must not start with `/`, and must not contain a `..` path segment (the same reasoning as ADR-0004's guard against real paths — a container should never contain a path that can escape its own root). In practice, font files live under `fonts/`, but the field itself doesn't enforce a directory name, only that the path is well-formed.

**Deduplication**: `family` is the unique key for a font within a presentation — the `fonts` array must not contain duplicate `family` values. When multiple slides reference the same font, they share a single `FontEntry` (and the same `file`), so the font file itself is never packaged more than once; the SVG only ever stores the `font-family` string reference, never the font data. A presentation created before this ADR, with no `fonts` field at all, is still structurally valid — that's exactly why the field is optional, following ADR-0003's existing forward-compatibility convention.

## Decision two: a standalone SVG opened offline degrades to a system font; only the app's own wrapper guarantees the correct font

**Choice**: `@font-face` is only injected inside the app's three wrapper documents (`wrapSlideDocument`/`wrapSelectionDocument`/`wrapPlayDocument`), via `/api/raw/fonts/...`. When a single SVG is opened by an external tool (a browser opening the file directly, Illustrator, Figma), there's no `@font-face` source to be found, and `font-family` falls back to that environment's system font per the CSS font-stack rules — the view won't break, but it isn't guaranteed to be pixel-identical to what's seen inside the app.

**Option rejected: base64-embed the font inside every SVG's own `@font-face`.**

Reasons for rejecting it:

- **File size isn't viable.** The CJK subset font currently in use is roughly 5.6MB (sfnt); base64 encoding adds roughly another third on top of that. If every SVG in an N-page deck embedded its own copy, the storage cost of the font scales N times over — a ten-page deck would mean fifty-plus MB of font data, repeated page after page. That's a serious size burden against ADR-0002's premise that a `.slidra` is one file.
- **It conflicts with an existing principle.** ADR-0015 already established a rule for media under `assets/`: "SVG must stay lean: no embedded base64," because SVG file size directly equals an agent's token cost per conversation turn. Base64-embedding a font is the same kind of harm, at a much larger scale (font files are far bigger than most media assets).
- **It wouldn't actually make a single SVG self-contained anyway.** Even base64-embedded, the environment opening it still needs to support `@font-face` plus `data:` URL sfnt decoding — this usually works, but it isn't a meaningful difference from "the artifact needs nothing external." It just swaps one external dependency (an HTTP route) for another (the browser's font decoder), buying none of what ADR-0001 actually wants while paying both of the costs above.

**This isn't the same kind of exception as "a slide is self-contained" for animation or effect lists (that's what ADR-0008 addresses, and it's unaffected by this ADR)** — an effect list has to live inside that slide's own SVG, or swapping page order would touch other files. Fonts are different: a font is a shared global resource, where duplication is the problem, and avoiding duplication is exactly what this ADR is for.

## Consequences

- The `.slidra` container gets a new `fonts/` directory; `project.json` gets a new optional `fonts` field, shaped as above.
- SVG only ever references a font through the `font-family` string — font data is never embedded.
- Node-side text measurement (APIs like `measurePresentationText`) must be able to look up a `family` in `project.json.fonts`, locate and parse the corresponding font file, and error explicitly if it can't be found (never fall back to a guessed width) — this follows the project's existing "no fallbacks" principle rather than introducing a new one, but it's worth calling out here, since a guessed measurement would make every downstream layout calculation untrustworthy.
- Acceptance criterion: the font seen inside the app (`serve`/playback/editing) must be the font the presentation actually specifies; opening a single slide SVG on its own is allowed to fall back to a system font, but the view itself must still be valid and legible (never blank, never erroring) — this is the concrete standard for the still-standing half of ADR-0001's "a static view must render correctly," as it applies to fonts.
