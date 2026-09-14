# Shape language: plain

**One line**: No particular shape claim: right angles, no shadow, minimal decoration. This is the default, and the least likely to go wrong.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

All rectangles are right-angled (`rx` unset). Dividers use thin lines or whitespace, not frames. The only decoration is a title underline and a footer line.

## Type character

A single typeface; hierarchy by weight and size. No italics, no letter-spacing.

## Whitespace rhythm

Use the middle levels of `layout.spacing`, evenly distributed. The gap between paragraphs is consistent; no dramatic jumps.

## Material and depth

Completely flat: no shadow, no gradient, no border. Hierarchy is carried by the base-color depth of `field`.

**Suited for**: Any context. Use it when unsure.
**Not suited for**: Contexts that need to be remembered — it deliberately has no personality.

## How to achieve it

Nothing special. This is the Section 4 skeleton as-is.
