# scale-drop

**Relationship solved**: `parent`
**Unit count**: 3–4
**One line**: Blocks that shrink level by level, arranged large to small — hierarchy expressed by size, no indentation and no lines.

**When to use it**: A hierarchy that also carries "range size" meaning (market → segment → audience, vision → goal → task).
**When not to use it**: The hierarchy is only membership, with no size difference.

## Wireframe

Full SVG: see `scale-drop.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Layers ×N | `node` (`field`) | area shrinking level by level | — | — |
| Layer name | `label` | font size shrinks along | 10 chars | 1 |
| Layer description | `label` | optional | 20 chars | 2 |

## Rhythm

**The area ratio must be obvious** (each next layer ~0.6 of the previous). Font size drops a level too — size and font size must move in the same direction, or the hierarchy fights itself. Vertically centered.

Write `blueprint.shape` as `scale-drop`.

## Variants

- **Concentric version**: three blocks become concentric, outermost largest — emphasizes "containment" rather than "sequence".
- **Small to large**: reversed, telling "growing from a small point into a big picture."
