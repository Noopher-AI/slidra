# vertical-cover

**Canvas**: 1080×1920 (9:16) **This is not a 16:9 layout**
**Relationship solved**: `none`
**Unit count**: 1
**One line**: Portrait cover: full-bleed image on top half, title on white below — the standard for social post covers and short-video thumbnails.

**When to use it**: Cover for a series of posts, the first frame of a short video.
**When not to use it**: Content pages.

## Wireframe

Full SVG: see `vertical-cover.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Image | `node` (`image`) | upper half, full-bleed | — | — |
| Short bar | `garnish` | | — | — |
| Main title | `label` | lower half, ≤ 2 lines | 6 chars/line | 1–2 |
| Subtitle | `label` | | 14 chars | 1 |
| Date/speaker | `label` | at the very bottom | 14 chars | 1 |

## Rhythm

Image takes the upper 60%, text area takes the lower part. **The main title must be large** (90+) — thumbnails on social feeds are thumb-sized. No footer.

Write `blueprint.shape` as `vertical-cover`.

## Setting the canvas

```
slidra presentation canvas set <presentation-id> --width 1080 --height 1920
```

The canvas must be set **before** creating the first page. Non-16:9 canvases **must not use `k = width ÷ 1280` for font size conversion** — that rule only holds for proportional canvases. Use the slot table directly for portrait and square layouts.

## Variants

- **Text over image**: remove the white base, add a scrim under the text over the lower half of the image.
- **Color-block base**: replace the image with a full-bleed solid color, suitable when no asset is available.
