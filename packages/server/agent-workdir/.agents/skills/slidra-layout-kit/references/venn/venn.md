# venn

**Relationship solved**: `overlap`
**Unit count**: 2–3
**One line**: Overlapping circles with the intersection clearly marked — shared and unique at a glance.

**When to use it**: Two or three things share a common part, and that common part is the point of this page.
**When not to use it**: Just comparing differences between two things — that is `contrast`, use `split-panel`. Don't use this layout when the intersection has no content.

## Wireframe

Full SVG: see `venn.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Circles ×N | `node` | semi-transparent so the intersection is visible | — | — |
| Individual labels | `label` | | 8 chars | 1 |
| Intersection label | `label` | **this is the key point** | 10 chars | 1 |
| Intersection description | `label` | below the diagram | 24 chars | 2 |

## Rhythm

The overlap area is about 25% of a single circle's area — too little and the shared part is invisible, too much and the unique parts disappear. Fills must be semi-transparent (opacity ~0.5), otherwise the intersection won't show its blended color.

Write `blueprint.shape` as `venn`.

## Variants

- **Three circles**: three equally spaced overlapping circles, the center is the three-way overlap — but three-circle label placement is tricky; keep content very short.
- **Square version**: use two overlapping rounded rectangles instead, more consistent with other layouts' visual vocabulary.
