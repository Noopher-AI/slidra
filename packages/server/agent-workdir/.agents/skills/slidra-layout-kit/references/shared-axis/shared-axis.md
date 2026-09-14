# shared-axis

**Relationship solved**: `contrast`
**Unit count**: 2
**One line**: A central reference axis with items on both sides expanding outward — a shared scale is the clearest way to read it.

**When to use it**: Both sides differ in quantity on the same dimension (positive/negative, increase/decrease, for/against).
**When not to use it**: Both sides compare quality rather than quantity — use `split-panel` instead.

## Wireframe

Full SVG: see `shared-axis.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Center axis | `spine` | the shared reference | — | — |
| Side headers ×2 | `label` | | 6 chars | 1 |
| Bars ×N | `node` | length reflects the value | — | — |
| Item names | `label` | on the outer side of the axis or on the bar | 10 chars | 1 |

## Rhythm

**Bar length must reflect real numbers.** Left and right rows align into the same rank — the two bars in the same rank are the two values of the same item.

Write `blueprint.shape` as `shared-axis`.

## Variants

- **No-value version**: both sides become equal length, membership expressed by position only — it degenerates into a lighter `split-panel`.
- **Horizontal axis**: the axis becomes horizontal, items expand up and down; suits time-ordered positive/negative values.
