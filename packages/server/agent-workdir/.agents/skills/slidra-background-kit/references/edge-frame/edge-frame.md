# edge-frame

**Mood**: A thin frame set at a distance from the edges, like a gallery picture frame or a certificate border. Formal, with a sense of ceremony.

**Suited for**: `anchor`. Most effective used once at the opening and once at the close.
**Not suited for**: `dense`. A frame closes in on an already crowded page.

**Suggested opacity**: 0.6

**Technique**: Two concentric thin rectangular frames, the inner one fainter; a short thickened segment at each of the four corners, mimicking the corner brackets of a picture frame.

Full SVG: see `edge-frame.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `warm` | Converge everything to warm tones: both primary and tertiary switch to accent. The whole image is just one hue's depth range; the warmest. | `var(--primary)` → `accent` |
| `low-key` | Drop a level: primary retreats to muted, accent rises to the lead. The pattern recedes further back; suited for pages that are already content-heavy. | `var(--primary)` → `muted`, `var(--accent)` → `primary` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 14, 18, 20, 21, 24.
