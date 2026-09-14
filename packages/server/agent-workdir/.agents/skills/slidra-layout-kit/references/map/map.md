# map

**Relationship solved**: `membership`
**Unit count**: 2–6
**One line**: A geographic outline with marker points and a legend on the right — spatial distribution is itself the message.

**When to use it**: Site locations, market coverage, regional data, supply chains.
**When not to use it**: The data has nothing to do with geography. A map makes people look for spatial relationships; if there are none, the page is wasted. **Do not add a map just for looks.**

## Wireframe

Full SVG: see `map.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Outline | `field` | simplified geographic shape | — | — |
| Markers ×N | `node` | point size can reflect quantity | — | — |
| Marker name | `label` | next to the point | 8 chars | 1 |
| Legend | `field` + `label` | explains what the points represent | 12 chars/line | 1 |

## Rhythm

The outline takes ~55% of the layout; the legend goes on the right. **Markers must not overlap each other**; for dense areas use one large point with a number instead of cramming in small ones. The outline is monochrome — no topography, which would compete with the markers.

Write `blueprint.shape` as `map`.

## Variants

- **Point size reflects quantity**: marker radius maps to the value; the legend must show the scale.
- **Regional coloring**: color the outline regions instead of placing points; suits comparing strength across regions.
