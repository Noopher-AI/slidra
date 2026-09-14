# Shape language: brutalist

**One line**: Newspaper-like density, thick black frames, raw structure. No ornamentation, no pandering — information laid out directly.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

**Thick frames** (3–5px) rather than base-color zoning. Right angles. Dividers use 2–3px solid lines. Elements may sit flush to the margins or even bleed.

## Type character

Sans-serif, with extreme weight contrast (the feel of 400 vs 900, achieved with 700 plus a larger type size). Titles can fill the entire line, even overflow the margins.

## Whitespace rhythm

**Tight**: `layout.spacing` uses only the two smallest levels; margins are narrowed. A page can go to the density limit.

## Material and depth

Completely flat, zero corner radius, zero shadow. Hierarchy is carried by frame weight and type scale.

**Suited for**: Investigative reporting, fact presentation, subculture, contexts that need "I'm not dressing this up."
**Not suited for**: Contexts needing approachability or trust.

## How to achieve it

`field` drops its base color and becomes a `stroke-width="4"` frame; `layout.side_margin` reduced by 16–24; `spacing` changed to [8, 12, 16, 24, 40].
