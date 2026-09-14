# Shape language: ink-wash

**One line**: Rice-paper whitespace, brush strokes, a single seal as the only emphasis. Quiet, breathing, Eastern.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

**Almost no geometric shapes**: no cards, no frames. Zoning is done with whitespace and one or two brush-stroke-like curves (drawn with `<path>`, uneven thickness). The only square is the seal — a small solid block with reversed-out text.

## Type character

Headings in serif or kaiti (`Noto Serif TC` / `cwTeXKai`), body in gothic. **Headings can be set vertically** (achieved with multiple text boxes, one character per line). Type scale contrast is large, but no weight is bold.

## Whitespace rhythm

**Whitespace occupies 70%**. One to three units per page. Content is concentrated on one side, the other side left entirely empty — that emptiness is part of the content.

## Material and depth

Completely flat, no shadow, no gradient. Hierarchy is carried by ink-ink darkness (the `text` → `muted` range).

**Suited for**: Culture, art, tea and food, brand stories, any context that needs to slow down.
**Not suited for**: Data presentations, process explanations — this language cannot carry dense information.

## How to achieve it

Remove all `field` elements; draw one or two brush strokes with `<path>`; the seal uses a `<rect>` with an `accent` fill and `background`-colored text; `layout.spacing` uses only the largest levels.
