# table-full

**Relationship solved**: `membership`
**Unit count**: 1 (table)
**One line**: One table fills the content area — data meant to be looked up, not a picture to admire.

**When to use it**: Many columns that need cell-by-cell comparison (specs, price lists, schedules).
**When not to use it**: Only two or three rows and columns — that's better as `30 split-thirds` or `01 card-wall`; table grid lines would feel like overkill.

## Wireframe

Full SVG: see `table-full.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Table | `node` (table) | header row required | — | — |
| Cells | — | each cell ≤ 10 chars | 10 chars | 1 |
| Source | `label` (`caption`) | include the data-as-of date | 24 chars | 1 |

## Rhythm

**Max 7 rows, max 5 columns** — beyond that it's a report, not a slide, and should be sent as an attachment. Numeric columns right-aligned, text columns left-aligned. Header row uses `secondary_bg`; body rows use zebra striping or nothing. No vertical grid lines.

Write `blueprint.shape` as `table-full`.

## How to place it

```
slidra table create <id> slides/00N.svg --rows 5 --cols 4 --x 80 --y 176 --header true
slidra table cell set <id> slides/00N.svg <element-id> --row 0 --col 0 --text 'Header One'
```

## Variants

- **Wider first column**: the first column holds names, double the width of the rest.
- **With a takeaway**: shrink the table to 70% width and put a one-line "what this table shows" on the right.
