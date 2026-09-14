# matrix-2x2

**Relationship solved**: `contrast`
**Unit count**: 4
**One line**: Two axes cut four quadrants, one position per cell — comparing two dimensions at once.

**When to use it**: Two independent dimensions, with items falling into different quadrants (cost vs benefit, urgent vs important).
**When not to use it**: Only one dimension. Four cells will force you to stretch items into four.

## Wireframe

Full SVG: see `matrix-2x2.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Two axes | `spine` ×2 | each labeled with its direction | — | — |
| Axis labels ×4 | `label` (`caption`) | high/low, each dimension's name | 6 chars | 1 |
| Quadrants ×4 | `node` (`field`) | | — | — |
| Quadrant content | `label` | | 16 chars | 1–2 |

## Rhythm

All four cells are equal size. **Usually one cell is the point** (the one you want to lead people to); make it darker or add an accent border — four equal-weight cells leave the audience not knowing where to look.

Write `blueprint.shape` as `matrix-2x2`.

## Variants

- **Only two filled**: only the two diagonal cells have content, emphasizing the trade-off.
- **Scatter version**: remove the grid lines, scatter dots within quadrants, one item per dot.
