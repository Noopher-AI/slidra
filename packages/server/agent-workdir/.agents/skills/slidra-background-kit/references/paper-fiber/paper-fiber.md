# paper-fiber

**Mood**: Very fine short diagonal lines randomly distributed, like paper fibers. You only notice it up close; from a distance it just reads as "this isn't a screen."

**Suited for**: Any rhythm, especially all pages of paper-feel styles.
**Not suited for**: Pure data pages. Any texture interferes with reading numbers.

**Suggested opacity**: 0.35

**Technique**: A 24px pattern with three short lines at slightly different angles. Lines in `muted` at low opacity.

Full SVG: see `paper-fiber.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `inked` | Deepen the texture to text color: grains and lines become more visible, giving the whole surface more of a print feel. Works best on light styles. | `var(--muted)` → `text` |
| `tinted` | Tint the texture with the primary color: the neutral texture becomes a colored texture, binding it more tightly to the style. | `var(--muted)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 05, 14, 16, 24.
