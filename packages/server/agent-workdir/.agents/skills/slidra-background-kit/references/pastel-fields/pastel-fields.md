# pastel-fields

**Mood**: Several pastel color fields with beveled edges adjacent on the right side, like stacked sheets of colored paper.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: `anchor`, `breathing`, and pages with `contrast` relationships (the cut edges are themselves dividers).
**Not suited for**: `dense`. The fields have boundaries, which will fight with card boundaries.

**Suggested opacity**: 0.75

**Technique**: The fields must have **boundaries**. The first version drew them as blobs bleeding into each other — on a light background everything smeared into one gray-brown mass. Only after switching to polygons with beveled edges did they hold up.

Full SVG: see `pastel-fields.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `tinted` | Base color takes the field: the large areas switch to the neutral `secondary_bg`, leaving only the frontmost layer saturated. | `var(--primary)` → `secondary_bg` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 05, 08, 11, 16, 22.
