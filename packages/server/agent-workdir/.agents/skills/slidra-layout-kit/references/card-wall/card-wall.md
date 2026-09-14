# card-wall

**Relationship solved**: `membership` (parallel, belonging, several items in the same group)
**Unit count**: 3–5
**One line**: Equal-height horizontal cards stacked vertically with even spacing — the most neutral parallel layout; no direction, no hierarchy.

**When to use it**: Items of equal status whose order is interchangeable. Three product features, four components.
**When not to use it**: When the content actually has sequence (`order`), contrast (`contrast`), or hierarchy (`parent`), the card wall flattens that meaning away. **Using it on two adjacent pages is the most common mistake**.

## Wireframe

Full SVG: see `card-wall.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | the claim for this page | 15 chars (max 24) | 1 |
| Title underline | `garnish` | accent bar | — | — |
| Cards ×N | `node` (containing a `field`) | one semantic unit each | — | — |
| Number | `label` | `01`/`02`… | 2 chars | 1 |
| Keyword | `label` | what this unit is about | 18 chars (max 32) | 1 |
| Footer trio | — | line, deck name, page number | — | — |

## Rhythm

Cards are equal height with even spacing — **uniformity is the point**, because parallel content has no emphasis. Card height and gap are derived from `layout.spacing`; the total height of N cards must not exceed `bottom_margin`.

Write `blueprint.shape` as `card-wall`; `type` can also be set to `bullets`.

**Animation**: one step for the title, then one step per card (1+N). Group each card with its number and keyword via `element group` first; the effect goes on the group.

## Variants

- **Narrow cards**: cards occupy only the left two-thirds, leaving the right side for an image or generous whitespace.
- **No field**: drop the card background, keep only number and keyword, separated by spacing and a thin divider — quieter, suits restrained styles like `clean-brief`.
