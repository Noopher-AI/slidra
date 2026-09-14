# indent-tree

**Relationship solved**: `parent`
**Unit count**: 1 + 3–6
**One line**: An indented hierarchical list — the most minimal and least ambiguous way to show governance.

**When to use it**: One thing decomposed into several sub-items, with no more than three levels.
**When not to use it**: More than three levels, or many items per level — that needs `nested-field`'s spatial layout.

## Wireframe

Full SVG: see `indent-tree.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Root | `node` | the thing being decomposed | 12 chars | 1 |
| Sub-items ×N | `node` | | 14 chars | 1 |
| Connector lines | `edge` | right-angle indent lines | — | — |

## Rhythm

Each level is indented by one `layout.gutter`. **Items at the same level must have their left edges perfectly aligned** — readability of the hierarchy depends entirely on this. Font size decreases one level per indent.

Write `blueprint.shape` as `indent-tree`.

## Variants

- **No lines**: remove the connector lines, rely on indentation and font size alone. Quieter, but beyond two levels it becomes unclear.
- **Right-side description column**: one sentence to the right of each sub-item.
