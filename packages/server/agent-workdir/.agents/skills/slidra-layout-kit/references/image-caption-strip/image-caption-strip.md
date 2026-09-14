# image-caption-strip

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A large image takes the upper two-thirds, with a caption strip below — the image is the subject, the text is a caption, not an argument.

**When to use it**: A single image speaks for itself (product photo, on-site photo, diagram) and the text only needs one or two sentences.
**When not to use it**: When the text is actually the point — use 22 `image-left` instead, giving half the layout back to text.

## Wireframe

Full SVG: see `image-caption-strip.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Image | `node` (`image`) | 3:1 to 16:9 wide banner | — | — |
| Caption | `label` | explains **what this image conveys**, not its content | 26 chars | 1 |
| Source | `label` (`caption`) | optional | 20 chars | 1 |

## Rhythm

The image width equals the safe-area width. The caption strip hugs the image's bottom edge (no gap), using `secondary_bg` as its base — it is part of the image, not a separate block.

Write `blueprint.shape` as `image-caption-strip`.

## How to place it

```
slidra asset import <id> <image path or URL>
slidra element insert image <id> slides/00N.svg --x 80 --y 160 --width 1120 --height 380 --media assets/<filename>
```

## Variants

- **Caption strip over the image**: make the caption strip semi-transparent and overlay it on the image's bottom edge — more compact.
- **Dual images**: two images side by side above, sharing the same caption strip.
