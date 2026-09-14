# hub

**Relationship solved**: `link`
**Unit count**: 1 + 3–6
**One line**: One central node with the others radiating outward, each connecting back to the center — instantly clear who is at the core.

**When to use it**: One thing links/supports all the others (platform and apps, core team and projects).
**When not to use it**: When the items also relate to each other — a radial layout would claim "they only relate to the center."

## Wireframe

Full SVG: see `hub.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Center | `node` | the core one | 8 chars | 1 |
| Periphery ×N | `node` | | 10 chars | 1 |
| Connecting lines ×N | `edge` | each connects back to the center | — | — |

## Rhythm

Peripheral nodes are **evenly distributed on the same circle** — do not scatter them arbitrarily. The center node is visibly larger than the periphery — size difference is hierarchy.

Write `blueprint.shape` as `hub`.

## Variants

- **Half-radial**: only expand to the right half, leaving the left for the title and description.
- **Dual center**: two cores each with their own peripherals, connected by a line between them — showing how two systems integrate.
