# image-left

**Relationship solved**: `membership`
**Unit count**: 1 + 2–4
**One line**: A full-height image on the left half, text on the right half — image and text each take half; neither dominates the other.

**When to use it**: You have one image that illustrates the topic, and the text is its interpretation.
**When not to use it**: The image is merely decorative. A half-layout image must actually carry content; otherwise use `card-wall` and give the space to text.

## Wireframe

Full SVG: see `image-left.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Image | `node` (`image`) | full-height bleed | — | — |
| Title | `label` | moved to the upper-right half | 14 chars | 1 |
| Key points ×N | `label` | | 18 chars each | 1–2 |

## Rhythm

The image **bleeds to the canvas edge** (x=0, y=0, full height) — no margins. Margins make it look pasted on. The text area's left edge starts from the image's right edge plus one `gutter`.

Write `blueprint.shape` as `image-left`.

## Variants

- **Right image, left text**: mirrored; suits reading flow that starts with text.
- **30/70 split**: image takes 30%, text gets more.
