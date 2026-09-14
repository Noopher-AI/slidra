# dotted-arc

**Mood**: Three arcs made of dots rising from the lower-right; light and directional.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: `anchor`, `breathing`, and pages with `order` relationships (the arcs have direction).
**Not suited for**: `membership`. Arcs point somewhere; parallel content should not have direction.

**Suggested opacity**: 0.7

**Technique**: Each arc must **sit inside the frame**, not just peek in at one corner. On a light background, dots need 3–5px at opacity 0.3–0.75; the innermost arc in accent, the outer two in primary, to pull the layers apart.

Full SVG: see `dotted-arc.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `cool` | Push the whole image to cool tones: the bright parts also go to primary, leaving only a lightness difference. | `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 04, 10, 12, 19, 22, 23.
