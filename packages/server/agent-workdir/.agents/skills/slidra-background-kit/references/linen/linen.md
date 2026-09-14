# linen

**Mood**: A fine interwoven texture covering the whole surface, like linen cloth, with the upper-left softened by a pool of base-color light.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: Any rhythm, especially all pages of paper-feel styles.
**Not suited for**: —

**Suggested opacity**: 0.5

**Technique**: The two directions (warp and weft) must differ in opacity by a level (0.34 / 0.20); equalize them and it becomes graph paper instead of cloth. The upper-left glow is drawn with `var(--background)` itself, returning the title area to clean paper.

Full SVG: see `linen.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `mono-ink` | Desaturate: everything uses muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`; `var(--accent)` → `muted` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 05, 09, 14, 16, 21, 24.
