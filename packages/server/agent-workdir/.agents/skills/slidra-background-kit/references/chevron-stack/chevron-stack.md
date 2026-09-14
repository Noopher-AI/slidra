# chevron-stack

**Mood**: A stack of chevrons in the lower half, getting more solid toward the bottom. Rhythmic and forward-moving, but completely avoids the text area in the upper half.

**Suited for**: `anchor`, `breathing`.
**Not suited for**: `dense`.

**Suggested opacity**: 0.6

**Technique**: Six thick zigzag lines occupying only the lower half; the upper half is left completely blank.

Full SVG: see `chevron-stack.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted` |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 07, 11, 15, 22.
