# Shape language: chalkboard

**One line**: Chalk writing on a dark board, with grainy strokes and uneven edges. Like a class in progress.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

Frame lines use **hand-drawn lines** (the same line drawn twice, slightly offset). Arrows and circling are freehand — don't use perfect geometry. There can be "erase marks that didn't come off clean" — a patch slightly lighter than the base color.

## Type character

A handwriting-style typeface; if none is available, use a rounded face at weight 400 with slightly wider letter-spacing. Headings can be slightly tilted (±1 degree).

## Whitespace rhythm

Looser than usual — chalkboard writing naturally has room to spread.

## Material and depth

The board uses a darker version of `background`; chalk uses `text` at `opacity` 0.85 (pure white is too sharp). Lines use two layers to create chalk's looseness.

**Suited for**: Teaching, workshops, courses, brainstorming records.
**Not suited for**: Formal external presentations.

## How to achieve it

Draw each line twice, the second offset by 1–2px with reduced opacity; `opacity` 0.85 for text; pair with dark styles (01, 04, 07).
