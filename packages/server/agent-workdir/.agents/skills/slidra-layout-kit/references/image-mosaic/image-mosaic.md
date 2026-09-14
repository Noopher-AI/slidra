# image-mosaic

**Relationship solved**: `membership`
**Unit count**: 4–7
**One line**: An uneven image mosaic — one hero image plus several smaller ones — more layered than a grid; suits a group of images with hierarchy.

**When to use it**: A group of images where one is clearly the hero (key visual, representative work, cover photo).
**When not to use it**: All images are equally important — use 24 `image-grid`; equal sizes avoid misleading.

## Wireframe

Full SVG: see `image-mosaic.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Hero image | `node` (`image`) | ~half the layout | — | — |
| Small images ×N | `node` (`image`) | equal size, arranged on the right | — | — |
| Caption | `label` | optional; one line for the hero only | 20 chars | 1 |

## Rhythm

One `gutter` between the hero image and the small-image cluster; half a `gutter` between small images. **All small images are the same size** — hierarchy has only two levels; three levels gets messy.

Write `blueprint.shape` as `image-mosaic`.

## Variants

- **Small-left, large-right**: hero on the right, reading starts from the small images.
- **Wide hero**: hero becomes a full-width top banner, small images in a row below.
