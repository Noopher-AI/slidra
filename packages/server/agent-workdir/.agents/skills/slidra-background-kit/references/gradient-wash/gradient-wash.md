# gradient-wash

**Mood**: A one-directional gradient from lower-left to upper-right, with no shapes at all. The quietest kind of background — it just keeps the frame from feeling flat.

**Suited for**: Any rhythm. This is the most general, safe choice.
**Not suited for**: Almost nothing. If you must pick, it's paper-feel styles that need texture.

**Suggested opacity**: 0.8 (dark styles) / 0.4 (light styles)

**Technique**: A linear gradient from `background` to `secondary_bg`, at 135 degrees. No second element.

Full SVG: see `gradient-wash.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `verdant` | Switch to tertiary-led. For most palettes, secondary_accent is a different hue family, which shifts the color temperature of the whole image. | `var(--primary)` → `secondary_accent`, `var(--accent)` → `primary` |
| `duotone` | Keep only two colors: everything besides the base converges into shades of the primary. The quietest treatment. | `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: All. Especially suited to the restrained styles 03, 06, 17, 21, 25.
