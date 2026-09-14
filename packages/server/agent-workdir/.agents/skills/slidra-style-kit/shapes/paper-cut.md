# Shape language: paper-cut

**One line**: Layers of cut paper stacked on top of each other, with a faint shadow between layers. Tactile, handmade; you can see the thickness of every layer.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

Shapes can be irregular (torn edges, beveled corners); not necessarily rectangles. Layers are **deliberately offset** — don't align them. Each layer's edge gets a thin line one step darker as its thickness.

## Type character

Sans-serif or rounded, weight 700 dominant — the paper layers are already busy, so the type should be simple.

## Whitespace rhythm

The overlap between layers is about 15–25% — you can read the front/back relationship without obscuring content.

## Material and depth

Hierarchy comes from **the base color's lightness difference**, not shadows. Each step up is one step lighter (dark styles) or darker (light styles).

**Suited for**: Handcraft, education, picture books, local culture, children.
**Not suited for**: Data-dense pages — irregular shapes make alignment difficult.

## How to achieve it

Change `field` to a `<path>` with beveled corners; offset adjacent layers by 40–80; add a 2px line one step darker along each layer's bottom edge.
