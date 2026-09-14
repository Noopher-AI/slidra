# media-stage

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A video (or audio) occupies the center of the stage with a line above explaining what to watch — a page that works both before and after playback.

**When to use it**: There is a real video/audio clip to play. Demos, interviews, live footage, product screens.
**When not to use it**: The material does not exist yet. **Do not place a placeholder black box** — without a video, use a different layout; swap it back when the material arrives.

## Wireframe

Full SVG: see `media-stage.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | **explains what to watch**, not the video filename | 18 chars | 1 |
| Video | `node` (`video` element) | 16:9 centered | — | — |
| Source and length | `label` (`caption`) | "Interview clip · 1 min 20 sec" | 20 chars | 1 |

## Rhythm

The video frame stays **16:9** (on a 1280×720 canvas, 800×450 centered is a safe size — space above for the title, below for the source). Do not make the video full-bleed: once full-bleed, the title has nowhere to go and the playback controls would cover content.

The title text must **still make sense after the video finishes** — the audience will return to the title to confirm what to remember.

Write `blueprint.shape` as `media-stage`.

**Animation**: one step only (title and video enter together). **Do not add an enter effect to the video element itself** — it would conflict with playback behavior.

## How to place it

```
slidra asset import <id> <video path or URL>
slidra element insert video <id> slides/00N.svg --x 240 --y 170 --width 800 --height 450 --media assets/<filename>
```

For external-platform videos use `--embed <provider>` plus `--href`; do not download and re-import.

## Variants

- **Video left, text right**: shrink the video to 640×360 on the left, three viewing points on the right — suits "watch while narrating".
- **Post-playback page**: same layout but the video is replaced by a screenshot with a conclusion overlaid — the next page after the video ends.
- **Audio**: `element insert audio`, frame becomes a narrow waveform strip (height 120), rest the same.
