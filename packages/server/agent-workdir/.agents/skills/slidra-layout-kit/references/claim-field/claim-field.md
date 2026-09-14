# claim-field

**Relationship solved**: `none`
**Unit count**: 1
**One line**: One sentence fills the page, everything else is whitespace — the strongest kind of page, because it explains nothing.

**When to use it**: Section transitions, the opening claim, the closing conclusion.
**When not to use it**: Content that needs evidence or explanation. This layout has no room for the "why".

## Wireframe

Full SVG: see `claim-field.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Short bar or label | `garnish` / `label` | optional | 6 chars | 1 |
| Claim | `label` (`claim` or `section` size) | ≤ 2 lines | 22 chars | 1–2 |
| Supplement | `label` | optional, two size levels down | 20 chars | 1 |

## Rhythm

The main text is flush left, vertically centered slightly above middle. **Whitespace is not unfinished layout, it is part of the content** — do not add things just because it feels empty.

Write `blueprint.shape` as `claim-field`.

## Variants

- **Centered version**: the claim is horizontally centered, more poster-like.
- **Numbered watermark**: an oversized section number in the lower-right (bare `<text>`, `garnish`, opacity 0.18).
