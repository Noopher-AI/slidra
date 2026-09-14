# cycle

**Relationship solved**: `order`
**Unit count**: 3–6
**One line**: A closed loop: nodes arranged around a circle, arrow returning to the start — the point is "there is no end."

**When to use it**: Iteration, lifecycle, continuous improvement, recurring processes.
**When not to use it**: Processes with a clear endpoint — that is `03 spine-path` or `09 chain`. Drawing a circle would claim a cycle that doesn't exist.

## Wireframe

Full SVG: see `cycle.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Ring spine | `spine` | Dashed circle, one per page | — | — |
| Nodes ×N | `node` | evenly spaced around the circle | — | — |
| Node number | `label` | | 4 chars | 1 |
| Phase name | `label` | placed outside the node | 10 chars | 1 |
| Loop arrow | `edge` | **at least one**, indicating direction | — | — |

## Rhythm

Nodes are evenly distributed on the same circle. **Arrows are required** — a circle without arrows is just a parallel arrangement, not a cycle. Four nodes look best; six is the upper limit.

Write `blueprint.shape` as `cycle`.

## Variants

- **Add a center**: place a `node` at the circle's center representing what the cycle drives.
- **Spiral**: change the circle to an outward spiral, indicating each round is bigger than the last.
