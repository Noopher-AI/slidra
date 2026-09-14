# image-grid

**Relationship solved**: `membership`
**Unit count**: 3–6
**One line**: Equal-sized image cells, each with a one-line caption — the standard solution for portfolios, case studies, and product lines.

**When to use it**: Multiple images of the same kind to display side by side.
**When not to use it**: The images have different importance, or there's only one or two — give the important one more space instead.

## Wireframe

Full SVG: see `image-grid.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Images ×N | `node` (`image`) | **cropped to the same aspect ratio** | — | — |
| Captions ×N | `label` | below each respective image | 12 chars | 1 |

## Rhythm

Images **must be the same ratio and same size** — a grid with varying sizes implies hierarchy. Use `gutter` for spacing; for six images, use two rows of three columns.

Write `blueprint.shape` as `image-grid`.

## Variants

- **Uneven grid**: the first image spans two cells, the rest split evenly — when one is clearly the hero.
- **No captions**: remove text, pure image wall, suitable for portfolios.
