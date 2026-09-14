# banded-list

**Relationship solved**: `membership`
**Unit count**: 3–5
**One line**: Single-column horizontal bands, layered by alternating base-color shades — like zebra stripes in a table, but without grid lines.

**When to use it**: Many items, each short, all equal in status.
**When not to use it**: Only two or three items — alternating base colors need enough rows for the pattern to read.

## Wireframe

Full SVG: see `banded-list.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Bands ×N | `node` (containing a `field`) | alternate two base colors | — | — |
| Keyword | `label` | | 24 chars | 1 |

## Rhythm

**No gap between the bands** (they separate by base color, not by whitespace). That is the biggest difference from `card-wall`, and the reason it fits more items.

Write `blueprint.shape` as `banded-list`.

## Variants

- **Right-aligned values**: a number on the right of each item turns it into a lightweight data table.
- **Emphasize the first item**: give the first band a `primary` base color as the focal point.
