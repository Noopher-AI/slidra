# mesh-gradient

**Mood**: Four color pools bleeding into each other across the frame, boundaries fully dissolved, like wet paint. Soft, layered, no hard edges.

**Suited for**: Any rhythm. The most general and most textural recipe.
**Not suited for**: Data pages that need to be absolutely clean.

**Suggested opacity**: 0.9 (dark) / 0.5 (light)

**Technique**: Four radial gradients, one per quadrant, layered from outside in. No `<filter>` — all softness comes from the gradient stop distribution.

Full SVG: see `mesh-gradient.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `duotone` | Keep only two colors: everything besides the base converges into shades of the primary. The quietest treatment. | `var(--accent)` → `primary` |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent`, `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: All, especially 01, 10, 15, 23.
