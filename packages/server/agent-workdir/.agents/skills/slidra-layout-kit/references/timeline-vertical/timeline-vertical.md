# timeline-vertical

**Relationship solved**: `order`
**Unit count**: 4–7
**One line**: A vertical main axis top-to-bottom, nodes on the axis, descriptions to the right — fits more stops than a horizontal timeline.

**When to use it**: Steps or years are numerous (five or more), each stop with one or two sentences of description.
**When not to use it**: Only three stops — the horizontal `spine-path` has more impact.

## Wireframe

Full SVG: see `timeline-vertical.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Main axis | `spine` | one line, full height | — | — |
| Nodes ×N | `node` | **last one filled** | — | — |
| Year/stop name | `label` | | 10 chars | 1 |
| Description | `label` | optional | 20 chars | 1–2 |

## Rhythm

Nodes are evenly spaced. Descriptions go **on the same side of the axis, always** — alternating left/right makes the reading order uncertain. The last node is filled or larger so the endpoint is distinct.

Write `blueprint.shape` as `timeline-vertical`.

## Variants

- **Segmented**: two or three thicker horizontal lines divide the timeline into eras.
- **Future dashed**: solid lines for what has happened, dashed lines for what's coming.
