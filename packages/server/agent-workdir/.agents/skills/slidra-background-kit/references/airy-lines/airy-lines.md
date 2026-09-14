# airy-lines

**Mood**: Ultra-thin horizontal lines spread from dense to sparse downward, like letter paper, with the right edge closed in a color band.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: `dense` (content pages), pages with `order` relationships.
**Not suited for**: `breathing`. Lines will chop up the whitespace.

**Suggested opacity**: 0.6

**Technique**: Spacing increases proportionally (×1.12), opacity decreases in sync, so the eye naturally converges upward. Lines need 1.4px / 0.10–0.45 on a light background to be visible — the 0.05 used in dark versions is essentially invisible here.

Full SVG: see `airy-lines.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `mono-ink` | Desaturate: everything uses muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted`; `var(--accent)` → `muted` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 03, 06, 09, 14, 17, 21, 25.
