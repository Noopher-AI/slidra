# wave-band

**Mood**: A wave-shaped band along the bottom edge of the frame, like a water surface or sound wave. Soft and fluid, occupying only the bottom.

**Suited for**: `anchor`, `breathing`. The content area is completely unaffected.
**Not suited for**: `dense` when content extends to the bottom.

**Suggested opacity**: 0.7

**Technique**: Two offset wave-shaped paths filling the bottom edge; the back one is lighter.

Full SVG: see `wave-band.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`, `var(--secondary_accent)` → `muted` |
| `verdant` | Switch to tertiary-led. For most palettes, secondary_accent is a different hue family, which shifts the color temperature of the whole image. | `var(--primary)` → `secondary_accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 10, 12, 23, 08.
