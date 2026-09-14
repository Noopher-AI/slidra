# split-thirds

**Relationship solved**: `membership`
**Unit count**: 3
**One line**: Three equal-width vertical columns, each running top to bottom — more suited than `card-wall` when each column holds multi-line text.

**When to use it**: Exactly three items, each with a title plus a few lines of description.
**When not to use it**: Four or more items (columns get too narrow) or each item is just one sentence (`card-wall` is more space-efficient).

## Wireframe

Full SVG: see `split-thirds.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Columns ×3 | `node` (`field`) | equal width and height | — | — |
| Top lines ×3 | `garnish` | same color (different colors would imply contrast) | — | — |
| Column headers ×3 | `label` | | 8 chars | 1 |
| Column body ×3 | `label` | **all three columns must have the same line count** | 16 chars each | 2–4 lines |

## Rhythm

Three columns equal in width and height; column headers and first-line baselines aligned. **Top lines must be the same color** — different colors would imply a comparison, which is `contrast`, not `membership`.

Write `blueprint.shape` as `split-thirds`.

## Variants

- **Middle emphasis**: the middle column is slightly wider or darker, marking it as the featured one.
- **Four columns**: switch to four, but each holds only a title and one line.
