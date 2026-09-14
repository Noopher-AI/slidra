# scatter-dots

**Mood**: Dots of varying sizes randomly scattered across the right half, like particles or star specks. Light and random; the irregularity keeps it from feeling rigid.

**Suited for**: `anchor`, `breathing`.
**Not suited for**: `dense`.

**Suggested opacity**: 0.55

**Technique**: Twelve circles with different radii and opacities, all in the right half; the left half stays clean.

Full SVG: see `scatter-dots.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `duotone` | Keep only two colors: everything besides the base converges into shades of the primary. The quietest treatment. | `var(--accent)` → `primary` |
| `low-key` | Drop a level: primary retreats to muted, accent becomes the lead. The pattern recedes further back; suited for already content-heavy pages. | `var(--primary)` → `muted`, `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 01, 04, 15, 23.
