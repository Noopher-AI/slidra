# shared-field

**Relationship solved**: `membership`
**Unit count**: 3–6
**One line**: All units in one large field, separated by thin dividers or whitespace — no individual cards, so it reads as "several facets of one thing" rather than "several things".

**When to use it**: Several items that all belong to one bigger thing (modules in a system, facets of a plan).
**When not to use it**: The items are actually independent — use `card-wall`; separate cards make them look individually discussable.

## Wireframe

Full SVG: see `shared-field.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | the claim for this page | 15 chars | 1 |
| Large field | `field` | covers all units | — | — |
| Units ×N | `node` | one per row | — | — |
| Number | `label` | `01`… | 2 chars | 1 |
| Keyword | `label` | | 18 chars | 1–2 |
| Divider | `garnish` | between units, **none after the last one** | — | — |

## Rhythm

Units are equal height; dividers fall in the middle. The field's height is determined by the unit count — do not leave a big blank at the bottom; shrink the field instead.

Write `blueprint.shape` as `shared-field`.

## Variants

- **No dividers**: remove the lines, group by whitespace only — quieter.
- **Label left, text right**: numbers and keywords split into two columns; suits longer keywords.
