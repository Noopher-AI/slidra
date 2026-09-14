# chart-pair

**Relationship solved**: `contrast`
**Unit count**: 2
**One line**: Two charts side by side sharing the same axes and legend — when comparing two data sets, a consistent scale is the only thing that matters.

**When to use it**: Two subjects, two periods, or two scenarios of the same metric.
**When not to use it**: The two data sets differ greatly in magnitude — a shared scale makes the smaller one invisible; use 27 `chart-focus` across two pages instead.

## Wireframe

Full SVG: see `chart-pair.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Charts ×2 | `node` (chart) | **axis ranges must match** | — | — |
| Labels ×2 | `label` | | 8 chars | 1 |
| Conclusion | `label` | where the difference is, what it means | 24 chars | 1–2 |

## Rhythm

The two charts are equal width and height. **The Y-axis range must be set manually** — auto-scaling lets each chart fill its own height, the most common visual lie. The legend appears once only (between the charts or below).

Write `blueprint.shape` as `chart-pair`.

## How to place it

```
slidra chart add <id> slides/00N.svg --type bar --x 80 --y 176 --width 540 --height 340
slidra chart data set <id> slides/00N.svg <element-id> --categories 'Q1,Q2,Q3' --series 'SubjectA=12,18,24'
```

## Variants

- **Stacked version**: charts stacked vertically, shared X axis — clearer for time-series comparison.
- **Overlay**: both series drawn on one chart (`chart axis` in `dual` mode), when they truly deserve a direct overlay.
