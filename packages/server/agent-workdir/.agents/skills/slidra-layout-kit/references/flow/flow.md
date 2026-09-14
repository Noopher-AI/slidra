# flow

**Relationship solved**: `link`
**Unit count**: 3–5
**One line**: A horizontal flow of source → transformation → result, where the middle cell is visibly more important.

**When to use it**: Processes with clear inputs and outputs (data pipelines, manufacturing processes, service flows).
**When not to use it**: Cycles or parallel items without clear input/output.

## Wireframe

Full SVG: see `flow.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Input | `node` | | 10 chars | 1 |
| Transformation | `node` (**the largest one**) | what this page is really about | 18 chars | 2 |
| Output | `node` | | 10 chars | 1 |
| Arrows | `edge` | | — | — |

## Rhythm

The middle transformation node should be visibly larger (1.5× width, 1.6× height) — **if all three are the same size, this is just a `chain`**, meaning you're not actually describing a transformation.

Write `blueprint.shape` as `flow`.

## Variants

- **Multiple inputs**: two or three small nodes on the left, each with an arrow pointing to the center.
- **Split output**: the right side branches into two results, telling "two outcomes of the same process."
