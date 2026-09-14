# bokeh-orbs

**Mood**: Bokeh circles of varying sizes scattered across the right half, like a defocused night scene. Soft, with depth and a sense of randomness.

**Suited for**: `anchor`, `breathing`.
**Not suited for**: `dense`.

**Suggested opacity**: 0.7

**Technique**: Each bokeh circle is a very faint fill plus a stroke outline; a radial gradient layer in the upper-right acts as a light source.

Full SVG: see `bokeh-orbs.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`, `var(--accent)` → `text` |
| `warm` | Converge everything to warm tones: both primary and tertiary switch to accent. The whole image is just one hue's depth range; the warmest. | `var(--primary)` → `accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 01, 15, 20, 23.
