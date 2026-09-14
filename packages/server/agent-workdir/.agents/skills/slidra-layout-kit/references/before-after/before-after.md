# before-after

**Relationship solved**: `contrast`
**Unit count**: 2
**One line**: Two stacked blocks with a divider between — before on top, after on the bottom. The sense of time is stronger than a left/right split.

**When to use it**: Two moments of the same thing (before/after a redesign, before/after rollout).
**When not to use it**: Comparing two different things — that is `split-panel`; left/right carries no time implication.

## Wireframe

Full SVG: see `before-after.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Top/bottom blocks | `node` (`field`) | equal height | — | — |
| Block name | `label` | "Before"/"After" or dates | 6 chars | 1 |
| Content | `label` | **both sides must have the same number of items** | 18 chars each | 2–3 items |
| Divider | `garnish` | can add a downward arrow | — | — |

## Rhythm

Top and bottom are equal height, first content lines aligned. **The "after" block's color should be slightly darker, or get one accent border** — otherwise readers can't tell which side is the result.

Write `blueprint.shape` as `before-after`.

## Variants

- **Left/right version**: switch to side-by-side; the time sense weakens but it suits juxtaposing longer lists.
- **Three segments**: before/process/after, with the middle segment slightly narrower.
