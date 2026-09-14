# split-diagonal

**Mood**: A diagonal line splitting the frame into a dark half and a light half. Clean, with tension, and naturally suited to left/right comparison.

**Suited for**: `anchor`, and pages with `contrast` relationships.
**Not suited for**: `dense` card walls — the split line would cut through the cards.

**Suggested opacity**: 0.7

**Technique**: A triangle path covering the lower-right half, colored `secondary_bg`; a thin accent line at the seam.

Full SVG: see `split-diagonal.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--accent)` → `primary` |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--accent)` → `text` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 07, 09, 11, 15, 22.
