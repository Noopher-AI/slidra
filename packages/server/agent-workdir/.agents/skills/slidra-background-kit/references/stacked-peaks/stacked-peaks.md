# stacked-peaks

**Mood**: Three layers of mountain ridgelines stacked from high to low. A sense of terrain, depth, and natural gaze direction upward.

**Suited for**: `anchor`, `breathing`.
**Not suited for**: `dense`.

**Suggested opacity**: 0.75

**Technique**: Three zigzag polyline paths, with the front ones more solid; peak heights are deliberately irregular.

Full SVG: see `stacked-peaks.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `verdant` | Switch to tertiary-led. For most palettes, secondary_accent is a different hue family, which shifts the color temperature of the whole image. | `var(--primary)` → `secondary_accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 10, 12, 24.
