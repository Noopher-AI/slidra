# soft-arches

**Mood**: Three large arches stacked from back to front on the right side, with a thin accent edge stroked on the frontmost one.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: `anchor`, `breathing`, and pages with `parent` relationships (the layered wrapping of the arches is itself enclosure).
**Not suited for**: `dense`.

**Suggested opacity**: 0.85

**Technique**: All three arches share **the same hue**, differing only in opacity; the accent appears only on the frontmost stroke. The first version made the front arch a solid accent layered over the primary arch, which blended into muddy ochre on cool palettes.

Full SVG: see `soft-arches.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `tinted` | Base color takes the field: the large areas switch to the neutral `secondary_bg`, leaving only the frontmost layer saturated. | `var(--primary)` → `secondary_bg` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 05, 08, 11, 16, 23, 24.
