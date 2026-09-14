# chart-small-multiples

**Relationship solved**: `membership`
**Unit count**: 4–9
**One line**: The same chart type repeated in small cells, one subject per cell — differences in shape are visible at a glance.

**When to use it**: One metric across many subjects (branches, months, product lines).
**When not to use it**: Fewer than four subjects — two big charts side by side are clearer.

## Wireframe

Full SVG: see `chart-small-multiples.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Mini charts ×N | `node` (chart) | **all same scale, same size** | — | — |
| Mini labels | `label` (`caption`) | subject name | 8 chars | 1 |
| Conclusion | `label` | what this group of shapes tells us | 24 chars | 1 |

## Rhythm

All cells are equal size; **all Y-axis ranges must match** — the entire value of this layout is "shapes are comparable", and any scale difference ruins it. Axis ticks are labeled only on the bottom-left cell; omitted elsewhere.

Write `blueprint.shape` as `chart-small-multiples`.

## Variants

- **Sorted**: order by value instead of by name; the shape trend emerges.
- **Flag outliers**: one or two cells get an accent border.
