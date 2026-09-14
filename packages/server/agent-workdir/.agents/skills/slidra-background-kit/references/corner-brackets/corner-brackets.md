# corner-brackets

**Mood**: A set of right-angle brackets in each of the four corners, like a viewfinder or scanner registration marks. Precise, with a tech feel.

**Suited for**: Any rhythm. It only occupies the four corners and doesn't interfere with the content area.
**Not suited for**: Almost nothing.

**Suggested opacity**: 0.6

**Technique**: Four right angles made of two-line segments, placed 48px from the edges.

Full SVG: see `corner-brackets.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--accent)` → `text` |
| `cool` | Converge everything to cool tones: the warm accent switches to tertiary. The same image becomes quieter; suited for content that needs calm. | `var(--accent)` → `secondary_accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 04, 07, 13, 22, 25.
