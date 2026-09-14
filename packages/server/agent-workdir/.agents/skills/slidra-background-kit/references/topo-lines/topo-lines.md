# topo-lines

**Mood**: Layered contour lines, like a topographic map. Layered, geographic, and each page can be different (change the path curvature).

**Suited for**: `anchor`, `breathing`.
**Not suited for**: `dense`. Curves conflict with tables and cards.

**Suggested opacity**: 0.45

**Technique**: Five parallel curves with different curvature, arranged bottom to top, lighter toward the top.

Full SVG: see `topo-lines.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `warm` | Converge everything to warm tones: both primary and tertiary switch to accent. The whole image is just one hue's depth range; the warmest. | `var(--secondary_accent)` → `accent` |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--secondary_accent)` → `muted` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 10, 12, 23, 24.
