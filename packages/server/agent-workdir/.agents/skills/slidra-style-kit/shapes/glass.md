# Shape language: glass

**One line**: Semi-transparent glass panels floating over a colored base, with a bright line on the edge. Modern, with depth, tech-feeling but not cold.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

Rounded rectangles (`rx` 12–20), filled **semi-transparent** (`opacity` 0.7–0.85), with a 1.5px bright line on the left or top edge simulating a glass edge. Panels may overlap slightly.

## Type character

Sans-serif, weight 400/700. Text always sits on the glass panels, never directly on the gradient base.

## Whitespace rhythm

Leave a gap of the base color between panels — the color behind must be visible for the glass effect to work.

## Material and depth

**The background must have something in it** (a gradient or blobs), otherwise the glass is transparent but there's nothing behind it. Pair with background library's `18 frosted-panel`, `31 mesh-gradient`, `32 blob-corners`.

**Suited for**: Product launches, cloud & tech, contexts needing a modern feel.
**Not suited for**: Print output, contexts needing very high contrast — semi-transparency reduces text contrast.

## How to achieve it

`field` uses the `background` color with `opacity="0.78"`; each panel's left edge gets a `<rect width="1.5" fill="<text>" opacity="0.22"/>`; pick background recipes that let color show through.
