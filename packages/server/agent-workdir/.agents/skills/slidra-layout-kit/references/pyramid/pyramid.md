# pyramid

**Relationship solved**: `parent`
**Unit count**: 3–5
**One line**: A wide-at-bottom, narrow-at-top layered stack; the base is the foundation, the top is the result.

**When to use it**: Hierarchies with a "the bottom must exist before the top" relationship (capability stacks, value hierarchies, levels of needs).
**When not to use it**: The layers are parallel — that is `membership`. A pyramid would claim a dependency that does not exist.

## Wireframe

Full SVG: see `pyramid.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Layers ×N | `node` | narrowing from bottom to top | — | — |
| Layer name | `label` | centered | 10 chars | 1 |
| Layer description | `label` | optional, on the right side | 18 chars | 1 |

## Rhythm

Each layer is equal height; width decreases linearly. **The top layer is emphasized (darker)** — it is the conclusion this structure leads to. No gaps between layers; gaps turn a "stack" into a "row".

Write `blueprint.shape` as `pyramid`.

## Variants

- **Inverted pyramid**: wide at top, narrow at bottom, telling "converging from a broad range to one conclusion."
- **Right-side description column**: one sentence to the right of each layer, suits few layers.
