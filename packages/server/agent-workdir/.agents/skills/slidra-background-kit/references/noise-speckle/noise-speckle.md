# noise-speckle

**Mood**: Very fine random speckles, like film grain or copier noise. Keeps flat-color backgrounds from feeling too "digital".

**Suited for**: Any rhythm.
**Not suited for**: Medical and data pages that need to be absolutely clean.

**Suggested opacity**: 0.3

**Technique**: A 60px pattern containing seven small circles of irregular positions and sizes. No `<filter>` for noise (filters are unstable on export).

Full SVG: see `noise-speckle.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `tinted` | Tint the texture with the primary color: the neutral texture becomes a colored texture, binding it more tightly to the style. | `var(--muted)` → `primary` |
| `inked` | Deepen the texture to text color: grains and lines become more visible, giving the whole surface more of a print feel. Works best on light styles. | `var(--muted)` → `text` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 05, 09, 22, 24.
