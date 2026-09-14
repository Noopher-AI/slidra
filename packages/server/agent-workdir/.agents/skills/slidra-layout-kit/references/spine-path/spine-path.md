# spine-path

**Relationship solved**: `order` (sequence, steps, process, time, ranking)
**Unit count**: 3–5
**One line**: A main axis (`spine`) strings evenly spaced nodes, with direction and endpoints visible — the most direct way to say "there is a before and after."

**When to use it**: Steps, timelines, processes, evolution.
**When not to use it**: Parallel content (that is `card-wall`). **Arranging sequential content as a card wall is the most common mistake** — readers will assume the items are interchangeable.

**How to read the direction**: three cues, need at least two. (1) The `spine`'s own direction (horizontal left-to-right, or vertical top-to-bottom); (2) the nodes' numbers or dates; (3) endpoint asymmetry — the start and end must be treated differently (e.g. the terminal node is filled, the others hollow).

## Wireframe

Full SVG: see `spine-path.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | the claim for this page | 15 chars (max 24) | 1 |
| Main axis | `spine` | one line, **one per page** | — | — |
| Nodes ×N | `node` | one per stop; the terminal one differs from the rest (filled or bolded) | — | — |
| Node number | `label` | `01` / year / step name | 4 chars | 1 |
| Node description | `label` | what happens at this stop | 12 chars (max 24) | 1–2 |
| Footer trio | — | | — | — |

## Rhythm

Nodes are evenly spaced on the axis. **When there are many nodes, switch to a vertical axis** (a line down the left edge, nodes top to bottom); more than five horizontally squashes the descriptions. Descriptions all go on the same side of the node — no alternating left/right; that makes the reading order uncertain.

Write `blueprint.shape` as `spine-path`. **There is no matching `type`**, so leave the plan's `type` empty.

**Animation**: 1+N steps — one step for the title (the spine follows with `with-previous`), then one step per node. Group each node with its number and description via `element group` first. Use `fly-left` (horizontal spine) or `fly-up` (vertical spine) to **reinforce direction**; do not use `fade`.

## Variants

- **Stepped** (`stepped`): remove the line, use blocks that rise or fall step by step — suits "growing gradually" or "converging gradually."
- **Big numbers leading** (`numbered-run`): remove the line and nodes, keep only big numbers with horizontal descriptions — the lightest sequence expression, suits few steps with short text.
- **Turns**: the spine does not have to be straight. When the process has branches or feedback, use a path with bends, and place a node at each bend.
