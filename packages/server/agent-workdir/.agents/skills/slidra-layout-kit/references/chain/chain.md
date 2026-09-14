# chain

**Relationship solved**: `link`
**Unit count**: 3–5
**One line**: Nodes connected in sequence with arrows — the difference from `spine-path`: the connections are drawn edges, not a shared axis.

**When to use it**: Each step "causes" the next, and the causality itself is the point.
**When not to use it**: Simple sequence without causality — arrows would claim a causation that does not exist.

## Wireframe

Full SVG: see `chain.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Nodes ×N | `node` (`field` + `label`) | | 12 chars | 1–2 |
| Arrows ×(N−1) | `edge` | **draw only the necessary connections** | — | — |
| Edge label | `label` | optional; states "because of what" | 8 chars | 1 |

## Rhythm

Nodes are equal in width and height, evenly spaced horizontally. Arrows are equal length. **The edge count must be N−1** — one extra edge means there is a branch, which means switch to `flow`.

Write `blueprint.shape` as `chain`.

## Variants

- **Edge labels**: a verb above each arrow explaining what makes that step happen.
- **Feedback**: an arc from the last node back to the first, indicating a loop.
