# stepped

**Relationship solved**: `order`
**Unit count**: 3–5
**One line**: Color blocks rising (or falling) step by step; the height itself is the message — you can see whether it's growing or converging.

**When to use it**: A sequence with quantity change: growth, decline, gradual approach.
**When not to use it**: Pure steps with no quantity concept — steps imply later ones are "bigger" than earlier ones.

## Wireframe

Full SVG: see `stepped.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Steps ×N | `node` (`field`) | height reflects the value | — | — |
| Step name | `label` | | 10 chars | 1 |
| Value | `label` | optional, at the top of the block | 8 chars | 1 |

## Rhythm

Blocks are equal width, bottom-aligned. **Height must reflect the real ratio** — if there are no real numbers, do not use this layout (it would be lying with visuals). Color darkens with height.

Write `blueprint.shape` as `stepped`.

## Variants

- **Descending version**: high to low, telling convergence or cost reduction.
- **With arrow**: a small arrow at the top-right of the final step, reinforcing "continuing."
