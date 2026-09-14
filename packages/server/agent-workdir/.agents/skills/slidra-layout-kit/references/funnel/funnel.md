# funnel

**Relationship solved**: `order`
**Unit count**: 3–5
**One line**: A wide-to-narrow stacked transformation; width represents quantity — you can see at a glance how much drops off at each layer.

**When to use it**: Conversion flows (marketing funnels, recruiting pipelines, sales pipelines) where **each layer has a real number**.
**When not to use it**: When there is no real quantity decrease between layers — the funnel shape would claim a drop-off that doesn't exist. Don't use without real numbers.

## Wireframe

Full SVG: see `funnel.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Funnel layers ×N | `node` | **width reflects real quantities** | — | — |
| Layer name | `label` | | 8 chars | 1 |
| Value | `label` | right-aligned | 8 chars | 1 |
| Conversion rate | `label` | optional, placed between layers | 6 chars | 1 |

## Rhythm

Each layer is equal height; width decreases according to real numbers. **The last layer is emphasized (darker)** — that's the result this page is really about. No gaps between layers.

Write `blueprint.shape` as `funnel`.

## Variants

- **Mark conversion rates**: write a percentage between each pair of layers, highlighting where the biggest drop-off is.
- **Horizontal**: change to left-to-right narrowing, suitable for combining with a timeline.
