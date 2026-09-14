# nested-field

**Relationship solved**: `parent`
**Unit count**: 1 + 2–4
**One line**: A large field containing smaller fields — the containment relationship is expressed directly as "inside", no lines needed.

**When to use it**: Children genuinely "belong to" the parent's space or domain (modules within a system, departments within an organization).
**When not to use it**: Children are "steps" or "attributes" of the parent rather than "members" — that is not containment.

## Wireframe

Full SVG: see `nested-field.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Parent field | `field` | encloses everything | — | — |
| Parent name | `label` | placed at the parent field's upper-left | 12 chars | 1 |
| Children ×N | `node` (each with its own `field`) | | 10 chars | 1 |
| Child content | `label` | | 16 chars each, 2–3 lines | 1 |

## Rhythm

The parent field's padding is at least a mid-level `layout.spacing` — **too little padding makes containment look like overlap**. Children are equal width and height.

Write `blueprint.shape` as `nested-field`.

## Variants

- **Unequal widths**: the primary child takes 50%, the rest split evenly — when children have hierarchy.
- **Two levels**: children contain grandchildren, but no more than two levels deep.
