# ten-print

**Mood**: A labyrinth texture composed of random diagonal lines (the 10 PRINT pattern). Fine, generative, and the more you look, the more you find paths.

**Suited for**: `dense`, `anchor`.
**Not suited for**: `breathing`.

**Suggested opacity**: 0.5

**Technique**: Each cell randomly draws a left-leaning or right-leaning line; the left half is faded with a gradient mask.

Full SVG: see `ten-print.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted` |
| `verdant` | Switch to tertiary-led. For most palettes, secondary_accent is a different hue family, which shifts the color temperature of the whole image. | `var(--primary)` → `secondary_accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 01, 04, 13, 22, 25.
