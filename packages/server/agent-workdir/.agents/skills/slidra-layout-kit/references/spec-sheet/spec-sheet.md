# spec-sheet

**Relationship solved**: `membership`
**Unit count**: 1 image + 4–8 specs
**One line**: Image on the left, spec table on the right — the standard product page: you can see the thing and look up the numbers.

**When to use it**: Physical products, plans, hardware specs.
**When not to use it**: Only two or three specs — use 26 `kpi-row` instead; a table would look fussy.

## Wireframe

Full SVG: see `spec-sheet.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | product or plan name | 14 chars | 1 |
| Image | `node` (`image`) | on the left | — | — |
| Spec rows ×N | `node` | item name + value | — | — |
| Item name | `label` | use `muted` | 8 chars | 1 |
| Value | `label` | use `text`, right-aligned | 12 chars | 1 |

## Rhythm

Item names and values form two aligned columns, separated by thin lines instead of grid lines. **Item names are lighter than values** — the person reading a table is looking for values, not for item names.

Write `blueprint.shape` as `spec-sheet`.

## Variants

- **Two-column specs**: split the specs into two columns, fitting eight or more items.
- **No image**: drop the image, specs take the full width — but that is really 43 `table-full`.
