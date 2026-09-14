# infographic

**Relationship solved**: `membership`
**Unit count**: 2–5
**One line**: Parallel vertical columns, each with an icon, a number, and a minimal label — the standard infographic layout.

**When to use it**: Several parallel items, each representable by one icon (step summaries, KPI overviews, element checklists).
**When not to use it**: Each item needs more than two lines of explanation — icons become mere decoration; use `30 split-thirds` instead.

## Wireframe

Full SVG: see `infographic.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Columns ×N | `node` (`field`) | equal width and height | — | — |
| Icon | `node` | one per column, from the same icon set | — | — |
| Number | `label` | | 2 chars | 1 |
| Label | `label` | **minimal**, one line | 10 chars | 1 |

## Rhythm

Columns are equal width and height, icons at the same vertical position. **Labels must be minimal** — this layout's value is being scannable at a glance; once text grows, it loses meaning. Four columns is the sweet spot; five is the maximum.

Write `blueprint.shape` as `infographic`.

## Variants

- **No frames**: remove the column backgrounds, group by icons and spacing only.
- **Add values**: a number below each label, turning it into a KPI overview.
