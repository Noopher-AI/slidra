# confetti-light

**Mood**: A cluster of small color chips falling in the upper-right corner; bright, light, and dynamic.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: `anchor` (cover, closing), `breathing`.
**Not suited for**: `dense`. The chips are bright enough to compete with content.

**Suggested opacity**: 1.0

**Technique**: **Keep them in one cluster**, don't scatter across the whole page. The first version that scattered them everywhere looked like dust, not decoration, on a light background. Position with a Gaussian distribution converging to the upper-right, opacity 0.45–0.9.

Full SVG: see `confetti-light.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `mono-ink` | Desaturate: everything uses muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`; `var(--accent)` → `muted` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 08, 11, 19, 22, 23, 25.
