# Shape language: data-dense

**One line**: Multi-column micro-charts, sidebars, source lines. Information density is the goal, not a side effect.

> Shape language **contains no colors**. Colors come from the style's `palette`; shape language only governs "how these shapes express themselves" — corner radii, decoration density, whitespace rhythm, type character, material. So any shape language can pair with any palette.

## Shapes and decoration

Thin frames or no frames, with **alignment** doing the zoning. Each block can be subdivided into smaller cells. A page may hold three or four charts. Source lines are fixed below each chart.

## Type character

Type scale one level smaller overall; numbers use a monospace face for alignment. Labels use the `caption` level and recede with the `muted` color.

## Whitespace rhythm

**Tight**: column spacing uses `layout.gutter`, but row spacing is pushed to the smallest level. Whitespace appears only between blocks, never inside them.

## Material and depth

Flat. Hierarchy is carried by type scale and color lightness difference, not by base-color blocks — base-color blocks in a dense layout make the frame noisy.

**Suited for**: Data presentations, dashboards, research data, financial report appendices.
**Not suited for**: Contexts needing emotion or a memorable hook.

## How to achieve it

Density set to `balanced` or `text`; `spacing` set to [4, 8, 12, 16, 24]; a `caption`-level source line added below each chart.
