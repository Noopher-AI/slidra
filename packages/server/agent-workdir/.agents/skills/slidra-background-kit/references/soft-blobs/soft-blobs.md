# soft-blobs

**Mood**: Three overlapping glows bleeding in from the right, boundaries fully dissolved. Like light through paper, or a drink photographed against the sun — warm, loose, no hard edges.

**Suited for**: `anchor` (cover, section, closing). These pages have little text and lots of whitespace, giving the glows room to spread.
**Not suited for**: `dense`. Cards on a gradient look dirty on content pages.

**Suggested opacity**: 0.9 (general) / 0.6 (closing pages whose base color is `primary` — the blobs become same-hue layers).

**Technique**: Three radial gradients using `primary`, `accent`, and `secondary_accent` respectively, all concentrated in the right half; no `<filter>`, softness comes from the gradient stop distribution.

Full SVG: see `soft-blobs.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `low-key` | Drop a level: primary retreats to muted, accent becomes the lead. The pattern recedes further back; suited for already content-heavy pages. | `var(--primary)` → `muted`, `var(--accent)` → `primary` |
| `warm` | Converge everything to warm tones: both primary and tertiary switch to accent. The whole image is just one hue's depth range; the warmest. | `var(--primary)` → `accent`, `var(--secondary_accent)` → `accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02 `warm-editorial` (best fit). 01 `editorial-tech`'s dark base swallows the blobs; if you must use it, raise opacity to 1.0 and increase the gradient stop-opacity.
