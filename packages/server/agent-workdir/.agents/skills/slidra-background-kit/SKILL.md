---
name: slidra-background-kit
description: Pick one of 47 background recipes, build it into an SVG asset, and apply it to pages; each recipe ships full SVG, suitable rhythm, and matching styles; a one-sentence mood description does a fuzzy match; also handles removing backgrounds. Use when the author's message starts with /slidra-background-kit, or when slidra-plan/slidra-build need to pick a background recipe
---

# Background library

Backgrounds carry **atmosphere**, not meaning: remove one and the page should not miss a single word. This skill maps the author's one-liner ("cleaner", "tech feel", "paper-like") to a recipe in the catalog, builds it with `asset import --svg`, then applies it with `slide background set`.

**The catalog is a starting point, not a whitelist.** You may tweak a recipe's parameters, mix two, or draw your own — as long as you keep three hard rules: no `<filter>` (blur via gradients, not filters; filters make thumbnails and exports inconsistent); keep the left half and center (x 80–760, y 72–648) quiet, with any personality only at the right edge and lower-right (dark-base recipes achieve this by darkening, light-base recipes by drawing nothing); large soft color fields use only `primary` and `accent` (use `secondary_bg` for a third layer); `secondary_accent` is only for lines and small areas — in many palettes it belongs to a different hue family, and a large area of it over the base becomes a muddy patch.

Recipe files write colors as CSS-variable syntax like `fill="var(--primary, #4F8DFF)"`, where the value after the comma is a preview default. When building the asset, replace each `var(--role, #default)` with this deck's actual color code.

## Input

```
/slidra-background-kit clean, almost invisible
/slidra-background-kit a bit more tech 2-4
/slidra-background-kit --none           ← remove the background image deck-wide
```

- Free text is the matching basis: mood, material, light/dark, reference targets.
- A trailing page range (`3`, `2-4`) constrains the application scope; when none is given, it applies to the whole deck.
- `--none` is removal: run `slide background set --none` on the specified range.

## Steps

1. **Read the style**: `slidra cat <presentation-id> plan/design-spec.md`. The background must use the same palette as the style. Look at the `background` color code to determine light/dark: 17 of the 25 styles are light-base.
2. **Read the index** and pick a recipe; when the author gives no description, follow the style file's "Suggested background" and each page's `rhythm`. `anchor` pages have little text and much whitespace, so they tolerate a distinctive background; `dense` pages already have cards and panels, so the background can only be a texture. Directional recipes (`19 dashed-path`, `38 perspective-floor`) are only for pages with an `order` relationship.
3. **Read only the chosen file**: `references/<name>/<name>.md`. One at a time.
4. **Confirm the canvas**: when it is not 1280×720, multiply all coordinates by `k = width ÷ 1280` and write the `viewBox` at the actual canvas size.
5. **Pick the color family**: each recipe file lists two role mappings besides `base`. The color family is a role-mapping table, not a set of color codes — the same image filled with a different role set still draws all its colors from this deck's palette. Content pages use `base`; anchor pages that want to differentiate from content pages use the other mapping; a deck uses at most two recipes and at most two color families.
6. **Build the asset**: replace `var(--role, …)` with the mapped role color codes, then `slidra asset import <presentation-id> --svg '<recipe SVG>' --name bg-<name>-<palette-code>[-<color-family>].svg`. Build the same recipe + same color family only once for the whole deck; note the returned `data.path`.
7. **Apply**: per page, `slidra slide background set <presentation-id> slides/00N.svg --asset <path> --opacity <suggested value>`. Opacity is tuned by the page's `rhythm` (each recipe file has suggested values). The background image is present from the first frame; do not animate it.
8. **Check**: `slidra validate <presentation-id>`. A background image makes `structure.scrim` start requiring text to have a base — if there are errors, add scrims per section 4b of `reference/slide-design.md`; lowering opacity is not a fix.

## The 47 recipes

| # | Name | Mood | Fits | Suggested style |
|---|---|---|---|---|
| 01 | `soft-blobs` | Three overlapping glows seep in from the right, edges fully dissolved. | `anchor` (cover, section, closing) | 02 `warm-editorial` (best match). 01 `editorial-tech`'s dark base will swallow the color blobs; if used, raise opacity to 1.0 and increase the gradient stop-opacity. |
| 02 | `dot-grid` | A uniform fine dot matrix fills the page, like a grid notebook or engineering paper. | `dense` (content pages) | 01 `editorial-tech`, 03 `clean-brief` (opacity must be lowered). 02 `warm-editorial`'s paper feel conflicts with the grid; not recommended. |
| 03 | `diagonal-beams` | Three beams slant from top-right to bottom-left; the left side is darkened by a radial gradient. | `anchor`, `breathing`, and `order`-relationship pages (the beams' direction reinforces reading direction) | 01 `editorial-tech`. On light-base styles the beams are too prominent; if used, drop opacity below 0.3. |
| 04 | `gradient-wash` | A single-direction gradient from lower-left to upper-right, with no shapes. | Any rhythm | All. Especially fits restrained styles like 03, 06, 17, 21, 25. |
| 05 | `corner-arc` | A large arc at the lower-right cuts into the frame, like an enlarged mark. | `anchor`, `breathing` | 01, 06, 13, 20, 23. |
| 06 | `paper-fiber` | Extremely fine diagonal short lines scattered randomly, like paper fibers. | Any rhythm, especially all pages of paper-feel styles | 02, 05, 14, 16, 24. |
| 07 | `edge-frame` | A thin frame set in from the edge, like an exhibition picture frame or a certificate border. | `anchor` | 14, 18, 20, 21, 24. |
| 08 | `halftone-fade` | A halftone dot screen that thins from lower-right to upper-left, like print halftone. | Both `anchor` and `dense` | 09, 22, 24. |
| 09 | `topo-lines` | Layered contour lines, like a topographic map. | `anchor`, `breathing` | 10, 12, 23, 24. |
| 11 | `grid-blueprint` | A full square grid with bolder major grid lines, like drafting paper. | `dense` | 13, 04, 25. |
| 12 | `arc-rings` | A set of concentric thin rings in the upper-right, like radar or a spreading sound wave. | `anchor`, `breathing` | 01, 04, 10, 15, 23. |
| 13 | `noise-speckle` | Extremely fine random specks, like film grain or copier noise. | Any rhythm | 02, 05, 09, 22, 24. |
| 14 | `split-diagonal` | A diagonal line splits the frame into a dark half and a light half. | `anchor`, and `contrast`-relationship pages | 07, 09, 11, 15, 22. |
| 15 | `soft-vignette` | Edges slightly darker, center slightly brighter, like a soft spotlight. | `breathing` (big numbers, a single claim) | 07, 15, 19, 20. |
| 16 | `stacked-strata` | Horizontal color bands fading level by level from bottom to top, like a geological cross-section. | `anchor`, `breathing` | 10, 12, 18, 24. |
| 18 | `frosted-panel` | A translucent frosted panel on the right half, like glass laid over the frame. | `anchor`, `dense` | 01, 15, 20, 23. |
| 19 | `dashed-path` | A dashed line curves from lower-left to upper-right, like a map path or a process trail. | `order`-relationship pages (it reinforces `spine-path`'s direction) | 05, 10, 12, 23. |
| 21 | `corner-brackets` | A set of right-angle brackets in each of the four corners, like a viewfinder or scan registration marks. | Any rhythm | 04, 07, 13, 22, 25. |
| 22 | `wave-band` | An undulating wave band along the bottom edge, like a water surface or a sound wave. | `anchor`, `breathing` | 10, 12, 23, 08. |
| 24 | `isometric-grid` | 30-degree isometric grid lines, like an engineering 3D drawing. | `dense`, especially pages about architecture or systems | 13, 04, 25. |
| 25 | `spotlight-top` | A beam of light from the top center, spreading downward. | `anchor` (cover), `breathing` | 07, 15, 19, 20. |
| 27 | `scatter-dots` | Varying-size dots scattered randomly on the right half, like particles or stars. | `anchor`, `breathing` | 01, 04, 15, 23. |
| 29 | `cross-ticks` | Evenly distributed small cross marks, like a design file's registration points or a star chart. | Any rhythm | 04, 06, 13, 25. |
| 31 | `mesh-gradient` | Four color masses bleeding into each other across the frame, edges fully dissolved, like wet paint. | Any rhythm | All, especially 01, 10, 15, 23. |
| 32 | `blob-corners` | Organic shapes at the upper-left and lower-right, leaving a clean diagonal channel in the middle. | `anchor`, `breathing` | 02, 08, 11, 16, 23. |
| 33 | `layered-waves` | Three layers of waves fill from top to bottom, colors getting more solid toward the bottom. | `anchor`, `breathing`; also usable for `dense` when content is concentrated in the upper half | 10, 12, 22, 23. |
| 34 | `stacked-peaks` | Three layers of mountain ridgelines stacked from high to low. | `anchor`, `breathing` | 10, 12, 24. |
| 35 | `low-poly` | The whole face cut into irregular triangles, like crumpled paper smoothed flat. | Any rhythm | 01, 04, 13, 15. |
| 36 | `polygon-scatter` | Seven varying-size polygons scattered on the right half, stroke only with no fill. | `anchor`, `breathing` | 01, 04, 13, 25. |
| 37 | `bokeh-orbs` | Varying-size light circles scattered on the right half, like an out-of-focus night scene. | `anchor`, `breathing` | 01, 15, 20, 23. |
| 38 | `perspective-floor` | Perspective grid lines on the horizon, converging to a vanishing point on the right. | `anchor`, `breathing`, and `order`-relationship pages | 01, 04, 13, 15. |
| 39 | `hex-mesh` | A hexagonal grid covering the whole face, like a honeycomb or molecular structure. | `dense` | 01, 04, 13, 25. |
| 40 | `chevron-stack` | A stack of chevrons in the lower half, more solid toward the bottom. | `anchor`, `breathing` | 07, 11, 15, 22. |
| 41 | `ten-print` | A maze texture made of random diagonal lines (the 10 PRINT pattern). | `dense`, `anchor` | 01, 04, 13, 22, 25. |
| 42 | `scales` | Half-circles layered into fish scales. | `dense`, `anchor` | 02, 05, 12, 24. |
| 43 | `ripple` | Concentric circles spreading out from the lower-right. | `anchor`, `breathing` | 01, 10, 15, 23. |
| 44 | `oscillate` | Ten undulating curves arranged in parallel, phases interleaved. | `dense`, `anchor` | 08, 10, 19, 22. |
| 45 | `grain-gradient` | A glow at the upper-right, the whole face covered with fine grain. | Any rhythm | 02, 05, 09, 22, 24. |
| 46 | `sunlit-wash` | Morning light slants in from the upper-right, bright to near overexposure; the left half is left blank. | `anchor`, `breathing` | ☀ 02, 08, 11, 16, 19, 23. |
| 47 | `pastel-fields` | A few pastel fields with diagonally cut edges adjacent on the right, like stacked color paper. | `anchor`, `breathing`, `contrast` | ☀ 02, 05, 08, 11, 16, 22. |
| 48 | `airy-lines` | Extremely fine horizontal lines, dense to sparse going down, like stationery paper. | `dense`, `order` | ☀ 03, 06, 09, 14, 17, 21, 25. |
| 49 | `confetti-light` | A cluster of small color chips at the upper-right corner; bright, light, dynamic. | `anchor`, `breathing` | ☀ 08, 11, 19, 22, 23, 25. |
| 50 | `soft-arches` | Three large arches stacked back-to-front on the right. | `anchor`, `breathing`, `parent` | ☀ 02, 05, 08, 11, 16, 23, 24. |
| 51 | `linen` | An extremely fine woven texture covering the whole face, like linen fabric. | Any rhythm | ☀ 02, 05, 09, 14, 16, 21, 24. |
| 52 | `edge-glow` | A narrow bright light band on the right edge and the top edge; the center is completely clean. | Any rhythm | ☀ All light-base styles. |
| 53 | `dotted-arc` | Three arcs made of dots rising from the lower-right. | `anchor`, `breathing`, `order` | ☀ 04, 10, 12, 19, 22, 23. |
| 54 | `washi` | Large very-pale color patches with even fiber specks, like hand-made washi. | Any rhythm | ☀ 02, 05, 09, 14, 16, 24. |

**Distinguish light from dark first.** The nine marked ☀ (46–54) are designed for **light-base palettes**; they're too weak on dark palettes. The rest are dark-base first; on light-base you must lower opacity. Light and dark bases cannot share one set of intensity numbers: on a light base, lines need 1.4px / opacity ≥ 0.2 and dots ≥ 3px to be visible, and large low-opacity soft color fields blur into a muddy gray-brown — the exact opposite holds for dark bases.

## Report format

First line: "Background: <name> — <one-line mood>, applied to pages N–M". Then a line with the asset path and per-page opacity. The final line lists two alternate recipes. When removing, reply with a single line stating which pages had it removed.
