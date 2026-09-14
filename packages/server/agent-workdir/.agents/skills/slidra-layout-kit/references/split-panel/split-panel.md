# split-panel

**Relationship solved**: `contrast` (A vs B, before/after, option comparison)
**Unit count**: 2
**One line**: Equal-width, equal-height panels on the left and right, sharing the same baseline — the difference is visible because everything else is the same.

**When to use it**: Comparing two things on the same dimension.
**When not to use it**: More than two items (that is `membership` or switch to `shared-axis`); or the two things actually have a before/after (that is `order`).

**The most common mistake**: different numbers of items per column or misaligned column headers. **The power of a comparison comes from aligning the invariants** — once the two sides have different layouts, the reader sees the layout difference before the content difference.

## Wireframe

Full SVG: see `split-panel.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | the claim for this page (usually "A vs B") | 15 chars (max 24) | 1 |
| Left/right panels | `node` (containing `field`) | one per side | — | — |
| Top bars ×2 | `garnish` | left `primary`, right `secondary_accent` — **color is the only thing that should differ between the two sides** | — | — |
| Column headers ×2 | `label` | who this column is | 8 chars | 1 |
| Column body ×2 | `label` | bullet list, **both columns must have the same count** | 18 chars each (max 32) | 2–4 items |
| VS circle | `node` divider (not `garnish`) | optional | 2 chars | 1 |
| Footer trio | — | | — | — |

## Rhythm

Both columns are equal width (each ~40% of the safe area, with at least `gutter × 2` between), equal height, top lines aligned, first-line baselines aligned. **When the item counts differ, pad one side or trim the other to match** — don't leave a column empty.

Write `blueprint.shape` as `split-panel`; `type` can also be set to `compare`.

**Animation**: 3 steps — title → left column as a group → right column as a group. The VS circle goes with the left column (it's a divider, not a standalone step).

## Variants

- **Top/bottom** (`before-after`): switch to top/bottom blocks with a divider between. Suits time-based comparisons like "before/after."
- **Shared baseline** (`shared-axis`): remove the panels, keep only a central vertical axis, items expand to both sides — lighter, suits fewer items.
