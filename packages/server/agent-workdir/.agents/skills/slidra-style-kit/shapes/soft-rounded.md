# Shape language: soft-rounded

**One line**: Rounded-corner cards, a soft lift, not a single sharp edge. Approachable, safe, easy to look at for a long time.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

All rectangles get rounded corners (`rx` is 1/4 of the height; cards about 16–24). `field` always has a base color. Icons and markers use circles rather than squares.

## Type character

Weight 400/700; headings can be slightly larger. Avoid serifs — rounded corners and serifs don't harmonize.

## Whitespace rhythm

Spacing is on the loose side; the gap between cards is slightly larger than the padding inside them, so each card reads as a separate block.

## Material and depth

A soft lift: cards use a base color **one step** lighter or darker than the background to express depth (do not use real shadows — SVG shadows are unstable on export).

**Suited for**: Education, children, community, internal communication, any context where you want the audience to relax.
**Not suited for**: Financial reports, compliance, crisis communication — rounded corners make the content feel less serious.

## How to achieve it

Add `rx` to every `rect`; `field` uses `secondary_bg`; card spacing is one level up from `layout.spacing`.
