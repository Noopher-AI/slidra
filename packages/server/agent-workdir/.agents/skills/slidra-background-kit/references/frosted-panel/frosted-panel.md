# frosted-panel

**Mood**: A semi-transparent frosted panel on the right half, like glass pressed over the frame. Text placed on the right is naturally supported by it.

**Suited for**: `anchor`, `dense`. This is one of the few backgrounds that includes its own scrim.
**Not suited for**: `breathing`. The panel would occupy the whitespace.

**Suggested opacity**: 0.85

**Technique**: A rounded rectangle filled with `background` color at opacity 0.7, plus a bright line on its left edge to simulate a glass edge.

Full SVG: see `frosted-panel.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`, `var(--accent)` → `text` |
| `duotone` | Keep only two colors: everything besides the base converges into shades of the primary. The quietest treatment. | `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 01, 15, 20, 23.
