# dot-grid

**Mood**: An even fine dot grid covering the whole page, like graph paper or engineering drawing paper. Quiet, regular, almost imperceptible — but remove it and the frame suddenly feels empty.

**Suited for**: `dense` (content pages). The dots provide a very faint texture for cards and panels to float on.
**Not suited for**: `breathing`. A breathing page wants emptiness; the grid would fill it up.

**Suggested opacity**: 0.5 (dark styles) / below 0.3 (light styles, otherwise it looks like graph paper).

**Technique**: A 16px `<pattern>` tiled across the page; dots in `muted`, radius 2. A very faint `primary` radial gradient in the upper-right breaks the total uniformity.

Full SVG: see `dot-grid.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`, `var(--accent)` → `text` |
| `warm` | Converge everything to warm tones: both primary and tertiary switch to accent. The whole image is just one hue's depth range; the warmest. | `var(--primary)` → `accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 01 `editorial-tech`, 03 `clean-brief` (keep opacity low). Not recommended for 02 `warm-editorial` — its paper feel clashes with the grid.
