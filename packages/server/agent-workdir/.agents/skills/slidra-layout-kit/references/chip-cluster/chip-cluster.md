# chip-cluster

**Relationship solved**: `membership`
**Unit count**: 5–12
**One line**: Varying-size tags scattered into a cluster with no grid alignment — like a wall covered in sticky notes.

**When to use it**: Many items, each very short (keywords, skills, tags, tool names).
**When not to use it**: Items that need to be explained one by one. This layout is for "see the whole picture at once", not sequential reveal.

## Wireframe

Full SVG: see `chip-cluster.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Chips ×N | `node` (rounded `field` + `label`) | one keyword each | 8 chars | 1 |

## Rhythm

**Do not align to a grid** — alignment turns it into an ugly table. Chip width follows text length, height is uniform; when wrapping, offset the left edge. Important chips can be bumped up one size level, but at most two per page.

Write `blueprint.shape` as `chip-cluster`.

## Variants

- **Grouped**: two or three whitespace bands divide the chips into clusters, each with a small heading.
- **Mixed fill/stroke**: existing items filled, planned items outlined.
