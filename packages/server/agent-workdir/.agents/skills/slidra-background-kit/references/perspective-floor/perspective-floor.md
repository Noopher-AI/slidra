# perspective-floor

**Mood**: Perspective grid on a horizon, converging toward a vanishing point on the right. Spatial, with depth, and self-evident direction.

**Suited for**: `anchor`, `breathing`, and pages with `order` relationships.
**Not suited for**: `membership`. Perspective has a direction; parallel content should not.

**Suggested opacity**: 0.6

**Technique**: All radial lines point at the same vanishing point; horizontal line spacing decreases geometrically to simulate perspective.

Full SVG: see `perspective-floor.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 01, 04, 13, 15.
