# layered-waves

**Mood**: Three layers of waves filling the page from top to bottom, colors getting more solid toward the bottom. Like a cross-section of water — weight and movement together.

**Suited for**: `anchor`, `breathing`; also `dense` when content is concentrated in the upper half.
**Not suited for**: Pages whose content extends to the bottom.

**Suggested opacity**: 0.8

**Technique**: Three paths; the top two use gradients, and the bottom layer is anchored with a solid `secondary_bg` fill.

Full SVG: see `layered-waves.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `verdant` | Switch to tertiary-led. For most palettes, secondary_accent is a different hue family, which shifts the color temperature of the whole image. | `var(--primary)` → `secondary_accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 10, 12, 22, 23.
