# edge-glow

**Mood**: A narrow bright band of light on the right edge and the top edge; the center and left are completely clean.

**Light style**: This is designed for light-background palettes. Dark palettes (01, 04, 07, 10, 13, 15, 18, 20) will make it too weak — either raise the opacity across the board by at least double, or switch to a dark-background recipe.

**Suited for**: Any rhythm — it is the least content-interfering recipe in this batch.
**Not suited for**: —

**Suggested opacity**: 0.8

**Technique**: The key is **narrow**. The light band must decay to near zero within 16% of the width; the first version let it spread to a third of the page width, and on a warm palette the entire right side smeared into brown.

Full SVG: see `edge-glow.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |
| `cool` | Push the whole image to cool tones: the bright parts also go to primary, leaving only a lightness difference. | `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: All. Works on the light styles 02, 03, 06, 08, 11, 12, 14, 16, 17, 19, 21, 23, 25.
