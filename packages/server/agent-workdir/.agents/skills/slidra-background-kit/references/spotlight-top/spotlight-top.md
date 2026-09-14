# spotlight-top

**Mood**: A beam of light falling from the top center, spreading as it goes down. Stage-like; attention naturally rises.

**Suited for**: `anchor` (cover), `breathing`.
**Not suited for**: `dense`. Brighter top and darker bottom make back-row cards look less important.

**Suggested opacity**: 0.7

**Technique**: A trapezoid path (wide at top, narrow at bottom) filled with a linear gradient that fades downward.

Full SVG: see `spotlight-top.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `duotone` | Keep only two colors: everything besides the base converges into shades of the primary. The quietest treatment. | `var(--accent)` → `primary` |
| `low-key` | Drop a level: primary retreats to muted, accent becomes the lead. The pattern recedes further back; suited for already content-heavy pages. | `var(--primary)` → `muted`, `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 07, 15, 19, 20.
