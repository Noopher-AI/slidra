# chart-annotated

**Relationship solved**: `none`
**Unit count**: 1
**One line**: One chart enlarged and centered, with callout lines on the key spot — "look here" drawn directly onto the chart.

**When to use it**: The chart has one clear turning point, anomaly, or peak, and that is the claim of this page.
**When not to use it**: The chart is about the overall trend with no specific point — that is 27 `chart-focus`.

## Wireframe

Full SVG: see `chart-annotated.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Chart | `node` (chart) | enlarged, centered | — | — |
| Marker | `node` | circles the key point | — | — |
| Callout line | `edge` | from marker to annotation | — | — |
| Annotation | `label` | **at most two per page** | 14 chars | 1–2 |
| Source | `label` (`caption`) | | 20 chars | 1 |

## Rhythm

Annotations go in the chart's whitespace; callout lines must not cross data. **More than two annotations means this chart is saying too many things** — split the page.

Write `blueprint.shape` as `chart-annotated`.

## Variants

- **Range marker**: a translucent block around a time span instead of a single point.
- **Dual annotations**: one marking the peak, one marking the trough, showing the gap.
