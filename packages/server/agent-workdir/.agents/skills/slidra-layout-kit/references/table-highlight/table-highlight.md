# table-highlight

**Relationship solved**: `contrast`
**Unit count**: 1 (table) + 1 emphasis
**One line**: One column (or row) in a table is clearly marked — the table is the background; the highlighted cell is the claim.

**When to use it**: Recommending one option from a set, or pointing out an outlier.
**When not to use it**: Nothing to recommend or flag — that's just `43 table-full`; the emphasis would mislead.

## Wireframe

Full SVG: see `table-highlight.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Table | `node` (table) | | — | — |
| Highlighted col/row | `node` | darker base or accent border | — | — |
| Reason | `label` | **why this one** | 24 chars | 1–2 |

## Rhythm

**Highlight exactly one spot per page.** Use base color OR border for emphasis, not both. The reason line is essential — a highlighted cell doesn't explain itself.

Write `blueprint.shape` as `table-highlight`.

## How to place it

```
slidra table cell style set <id> slides/00N.svg <element-id> --row 0 --col 2 --fill '<secondary_bg>'
```

## Variants

- **Highlight a row**: emphasize how one item performs across all options (horizontal emphasis).
- **Cross out**: fade the non-recommended columns with `muted` instead of emphasizing the recommended one — the reverse approach can be more persuasive sometimes.
