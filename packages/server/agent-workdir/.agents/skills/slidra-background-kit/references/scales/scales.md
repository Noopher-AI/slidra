# scales

**Mood**: Overlapping semicircles layered like fish scales. Organic, regular, with a touch of Eastern decorative flavor.

**Suited for**: `dense`, `anchor`.
**Not suited for**: `breathing`.

**Suggested opacity**: 0.5

**Technique**: Semicircular arcs arranged in a stagger; odd and even rows offset by half a unit.

Full SVG: see `scales.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--secondary_accent)` → `muted` |
| `cool` | Converge everything to cool tones: the warm accent switches to tertiary. The same image becomes quieter; suited for content that needs calm. | `var(--secondary_accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 05, 12, 24.
