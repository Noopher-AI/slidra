# halftone-fade

**Mood**: A halftone dot pattern that thins from lower-right toward upper-left, like print halftone. Grainy, directional, with a vintage feel.

**Suited for**: Both `anchor` and `dense`.
**Not suited for**: Data pages that need to be extremely clean.

**Suggested opacity**: 0.5

**Technique**: A 12px dot pattern tiled across the page, overlaid with a gradient mask from upper-left to lower-right so the dots disappear completely at the upper-left.

Full SVG: see `halftone-fade.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `verdant` | Switch to tertiary-led. For most palettes, secondary_accent is a different hue family, which shifts the color temperature of the whole image. | `var(--primary)` → `secondary_accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 09, 22, 24.
