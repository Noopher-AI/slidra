# blob-corners

**Mood**: Organic shapes in the upper-left and lower-right corners, leaving a clean diagonal channel in the middle. Organic, asymmetric, but well balanced.

**Suited for**: `anchor`, `breathing`.
**Not suited for**: `dense`. Organic edges will clash with card right angles.

**Suggested opacity**: 0.85

**Technique**: Two free-form paths, each filled with a two-color linear gradient; the upper-left blob is deliberately extended beyond the canvas edge.

Full SVG: see `blob-corners.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`, `var(--accent)` → `text`, `var(--secondary_accent)` → `muted` |
| `warm` | Converge everything to warm tones: both primary and tertiary switch to accent. The whole image is just one hue's depth range; the warmest. | `var(--primary)` → `accent`, `var(--secondary_accent)` → `accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 08, 11, 16, 23.
