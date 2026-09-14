# diagonal-beams

**Mood**: Three beams slanting from upper-right to lower-left, with the left side darkened by a radial gradient. **Directional and fast** — that is this recipe's most important property, and its limitation.

**Suited for**: `anchor`, `breathing`, and pages with `order` relationships (the beam direction reinforces reading direction).
**Not suited for**: `membership` pages. Parallel content with a directional background makes the background say the wrong thing.

**Suggested opacity**: 0.7.

**Technique**: Long path bars — two in `primary`, one in `accent`, all at the same angle; a radial gradient layer on the left darkens the text area.

Full SVG: see `diagonal-beams.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `cool` | Converge everything to cool tones: the warm accent switches to tertiary. The same image becomes quieter; suited for content that needs calm. | `var(--accent)` → `secondary_accent` |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`, `var(--accent)` → `text` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 01 `editorial-tech`. On light-background styles the beams stand out too much; if you must use them, drop opacity below 0.3.
