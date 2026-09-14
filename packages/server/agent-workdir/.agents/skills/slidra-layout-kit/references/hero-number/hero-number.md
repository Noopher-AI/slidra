# hero-number

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A very large number centered, with one line of explanation below — the entire page says one thing.

**When to use it**: There is a real, author-sourced number, and it is itself the claim.
**When not to use it**: No number, or the number needs context to make sense (establish that context first). **Never fabricate numbers.**

## Wireframe

Full SVG: see `hero-number.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Big number | `label` (`number` size) | only from the author's outline | 8 chars | 1 |
| Explanation | `label` | what this number represents | 24 chars | 1–2 |
| Source | `label` | optional | 20 chars | 1 |

## Rhythm

**No title** — the number itself is the title. Everything is centered, with the vertical center of gravity slightly above the canvas center (the visual center is higher than the geometric center). When there's no number, just a claim, use the `claim` size instead.

Write `blueprint.shape` as `hero-number`.

## Variants

- **Split left/right**: number on the left, explanation on the right; suits very long numbers.
- **Two numbers**: two side by side with a divider — but that's really `contrast`; consider a different layout.
