# video-grid

**Relationship solved**: `membership`
**Unit count**: 2–4
**One line**: Several short clips side by side, each with a one-line description — clips of the same kind and short length, watched together.

**When to use it**: Multiple clips of the same nature (different implementations, several use cases, multiple test runs).
**When not to use it**: Clips vary widely in length — the longest one will never get to play and becomes decoration.

## Wireframe

Full SVG: see `video-grid.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Videos ×N | `node` (`video`) | same size | — | — |
| Descriptions ×N | `label` | each below its clip | 14 chars | 1 |

## Rhythm

All clips equal size, 16:9. **Four is the maximum** — beyond that, no one remembers what the first clip showed.

Write `blueprint.shape` as `video-grid`.

## Variants

- **One large, three small**: one main clip plus three short ones, same logic as 34 `image-mosaic`.
- **Screenshots instead**: when live playback isn't feasible, use three screenshots and note the narration in the speaker notes.
