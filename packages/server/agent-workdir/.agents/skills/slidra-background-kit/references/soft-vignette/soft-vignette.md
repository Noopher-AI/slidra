# soft-vignette

**Mood**: Slightly darker edges, slightly brighter center — like a soft spotlight is on. You can't tell anything is there, just that attention is drawn to the middle.

**Suited for**: `breathing` (big numbers, a single claim).
**Not suited for**: `dense`. A brighter center makes the two rows of a card wall look uneven.

**Suggested opacity**: 0.8

**Technique**: One elliptical radial gradient, center transparent and edges in a darker version of `background`; no `<filter>`.

Full SVG: see `soft-vignette.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted` |
| `verdant` | Switch to tertiary-led. For most palettes, secondary_accent is a different hue family, which shifts the color temperature of the whole image. | `var(--primary)` → `secondary_accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 07, 15, 19, 20.
