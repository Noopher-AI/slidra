# Shape language: swiss-minimal

**One line**: Grid-locked, razor-sharp edges, aggressive whitespace, near-zero decoration. Everything is aligned; one more line would be one too many.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

Right angles, **no rounded corners at all**. No card base color — zoning is done by alignment and heavy whitespace. The only permitted decoration is one 2px rule line.

## Type character

A single sans-serif, two weights only (400/700). Headings are left-aligned, never centered. Letter-spacing is slightly tightened (the concept of −0.01em, achieved by narrowing with `data-slidra-text-width`).

## Whitespace rhythm

**Whitespace is the protagonist**: `layout.spacing` uses only the two largest levels. At most three units per page; split into more pages if needed. Margins are one to two levels wider than the default.

## Material and depth

Purely flat, zero shadow, zero gradient. Hierarchy only through position and type scale.

**Suited for**: Design proposals, product philosophy, architecture, restrained professional contexts.
**Not suited for**: Information-dense pages — this language can't hold that much.

## How to achieve it

Remove the base color from `field`, keeping only `node` and `label`; increase `layout.side_margin` by 20–40; reduce units per page to 3 or fewer.
