# video-side-notes

**Relationship solved**: `none`
**Unit count**: 1 + 2–4
**One line**: Video on the left, viewing key points on the right — watch while narrating, the audience knows what to look for.

**When to use it**: The video is longer than a minute and needs a pre-brief on what to watch for.
**When not to use it**: The video is only a few seconds — use 31 `media-stage` and give the page to the video.

## Wireframe

Full SVG: see `video-side-notes.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Video | `node` (`video`) | 16:9, on the left | — | — |
| Key points ×N | `label` | **state these before the video plays** | 16 chars each | 1 |
| Length/source | `label` (`caption`) | | 18 chars | 1 |

## Rhythm

The video stays 16:9 (640×360). Key points are **top-aligned with the video**, vertically evenly spaced. The key points' font size must not exceed the title.

Write `blueprint.shape` as `video-side-notes`.

## How to place it

```
slidra asset import <id> <video path>
slidra element insert video <id> slides/00N.svg --x 80 --y 200 --width 640 --height 360 --media assets/<filename>
```

## Variants

- **Key points on the left**: video on the right, suits "explain first, then watch."
- **Time codes on key points**: each key point prefixed with "0:35" so the audience knows when it appears.
