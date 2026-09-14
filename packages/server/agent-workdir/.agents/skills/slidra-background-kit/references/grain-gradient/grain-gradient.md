# grain-gradient

**Mood**: A patch of light in the upper-right with fine grain covering the whole surface. Like high-ISO film — light and noise together, not digitally clean.

**Suited for**: Any rhythm.
**Not suited for**: Data pages that need to be absolutely clean.

**Suggested opacity**: 0.7

**Technique**: A radial gradient plus three thousand 2–3px square dots, with density varying by position. Do not use `<filter>` to generate noise (filters are unstable on export).

Full SVG: see `grain-gradient.svg` in the same folder.

## Two alternative color schemes

Swapping the role assignments on the same image produces another color scheme — colors still all come from this deck's own palette, so nothing clashes with the style. When writing the asset, replace `var(--role)` with the **mapped** role color code; the SVG itself needs no changes.

| Scheme | Effect | Role mapping |
|---|---|---|
| `base` | As-is, use the SVG below directly | — |
| `mono-ink` | Desaturate: everything uses text color and muted. The most restrained treatment, nearly just light and dark; suited for data pages and restrained styles. | `var(--primary)` → `muted` |
| `accent-led` | Swap primary and accent: wherever primary was used, use accent instead. The same image goes from calm to bright; suited for pages that need warmth. | `var(--primary)` → `accent` |

A deck uses **at most two color schemes** (typically `base` for content pages, the other for anchor pages); three or more make the whole deck look like a collage. Include the scheme in the asset name, e.g. `bg-<recipe>-<palette-code>-accent-led.svg`.

**Suggested styles**: 02, 05, 09, 22, 24.
