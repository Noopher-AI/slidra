# image-pair-compare

**Relationship solved**: `contrast`
**Unit count**: 2
**One line**: Two images side by side with a divider between — compare with images; text just labels what each side is.

**When to use it**: Two states or two versions of the same thing, where the difference is fastest to see by looking.
**When not to use it**: The two images have different shooting angles or scales — the comparison will be distorted; crop them to match first.

## Wireframe

Full SVG: see `image-pair-compare.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Images ×2 | `node` (`image`) | **same size, same ratio** | — | — |
| Labels ×2 | `label` | "Before/After" or version names | 6 chars | 1 |
| Difference note | `label` | one sentence pointing out where to look | 22 chars | 1 |

## Rhythm

Both images are equal width and height, top-aligned. **The difference note must point out "where to look"** — without it, the audience will look on their own and often look in the wrong place.

Write `blueprint.shape` as `image-pair-compare`.

## How to place it

```
slidra element insert image <id> slides/00N.svg --x 80 --y 176 --width 540 --height 340 --media assets/<before.jpg>
slidra element insert image <id> slides/00N.svg --x 660 --y 176 --width 540 --height 340 --media assets/<after.jpg>
```

## Variants

- **Stacked version**: switch to top/bottom arrangement; the time sense is stronger (same logic as 17 `before-after`).
- **Local zoom-in**: add a zoomed-in inset frame on one image, pointing out the key difference.
