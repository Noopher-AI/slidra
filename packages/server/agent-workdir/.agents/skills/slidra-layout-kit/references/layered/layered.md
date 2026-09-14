# layered

**Relationship solved**: `overlap`
**Unit count**: 2–4
**One line**: Stacked blocks arranged with offsets; the shared overlapping region is on top — better than `venn` for holding text.

**When to use it**: Several things share a common foundation or overlap, and each layer needs to hold a sentence.
**When not to use it**: Only two things with a simple intersection — `venn` is more intuitive.

## Wireframe

Full SVG: see `layered.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Layers ×N | `node` (`field`) | offset and overlapping | — | — |
| Layer name | `label` | placed in a corner not covered by others | 10 chars | 1 |
| Shared zone | `node` | the darkest color | 8 chars | 1 |

## Rhythm

The offset distance is about 40% of the block width. **The shared zone must be the darkest color** — otherwise it looks like two blocks that happen to overlap. Layer names must be placed where they are not covered.

Write `blueprint.shape` as `layered`.

## Variants

- **Three-step staircase**: three blocks offset in sequence, like playing cards fanned out.
- **Wider base**: the bottom layer is visibly larger, indicating it is the foundation, not an equal layer.
