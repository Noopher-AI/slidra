# cover-stack

**Relationship solved**: `none`
**Unit count**: 1
**One line**: Title, subtitle, and date/speaker stacked top-down, flush left — the standard cover.

**When to use it**: Covers.
**When not to use it**: Content pages.

## Wireframe

Full SVG: see `cover-stack.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Short bar | `garnish` | accent color | — | — |
| Main title | `label` (`cover` size) | the strongest line in the outline | 15 chars/line, ≤ 2 lines | 1–2 |
| Subtitle | `label` (`subtitle`) | | 24 chars | 1 |
| Date/speaker | `label` (`caption`) | | 20 chars | 1 |

## Rhythm

All four items share the same left edge; vertical gaps use the larger `layout.spacing` steps. **No footer**. The gap between the main title and subtitle must be clearly larger than the gap between subtitle and date — that is the grouping.

Write `blueprint.shape` as `cover-stack`.

## Variants

- **Centered version**: everything horizontally centered; suits poster-like styles such as `luxury-noir` and `bold-poster`.
- **Lower-right info**: move the date/speaker to the lower-right, forming a diagonal balance with the title.
