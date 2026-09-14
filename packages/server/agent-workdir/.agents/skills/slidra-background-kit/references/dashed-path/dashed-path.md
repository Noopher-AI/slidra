# dashed-path

**Mood**: A dashed line curving from the lower-left to the upper-right, like a route on a map or the trail of a process. It has a start, an end, and a direction.

**Suited for**: Pages with `order` relationships (it reinforces the direction of `spine-path`).
**Not suited for**: `membership`.

**Suggested opacity**: 0.6

**Technique**: A `stroke-dasharray` curve with a small circle at each end marking the start and the finish.

Full SVG: see `dashed-path.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `duotone` | Keep only two colors: everything besides the base converges into shades of the primary. The quietest treatment. | `var(--accent)` → `primary` |
| `warm` | Converge everything to warm tones: both primary and tertiary switch to accent. The whole image is just one hue's depth range; the warmest. | `var(--primary)` → `accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 05, 10, 12, 23.
