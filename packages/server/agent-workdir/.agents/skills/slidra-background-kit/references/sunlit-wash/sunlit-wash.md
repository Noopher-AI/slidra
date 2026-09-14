# sunlit-wash

**Mood**: Morning light streaming diagonally from the upper-right, bright to near overexposure, with the left half left completely blank.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: `anchor`, `breathing` (cover, section, single claim).
**Not suited for**: `dense`. The upper-right highlight would cover any cards placed there.

**Suggested opacity**: 0.9

**Technique**: One light source only: a large accent radial gradient sets the tone, with a small white specular highlight at the center. Nothing is drawn in the left half.

Full SVG: see `sunlit-wash.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `cool` | Push the whole image to cool tones: the bright parts also go to primary, leaving only a lightness difference. | `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 08, 11, 16, 19, 23.
