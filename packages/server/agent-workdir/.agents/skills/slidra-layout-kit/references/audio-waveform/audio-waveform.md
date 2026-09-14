# audio-waveform

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A waveform strip spanning the layout, with a one-line "what to listen for" above and per-word highlights below — sound has no picture, so the layout has to supply it.

**When to use it**: Interview clips, support recordings, live footage, podcast excerpts.
**When not to use it**: The audio is just background music. Background music does not need a page.

## Wireframe

Full SVG: see `audio-waveform.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 15 chars | 1 |
| Lead line | `label` | what to listen for | 20 chars | 1 |
| Waveform strip | `node` (`audio`) | spans the safe area | — | — |
| Per-word highlights ×N | `label` | **for following along during playback**, not a full verbatim transcript | 22 chars each | 1 |
| Source | `label` (`caption`) | interviewee and length | 20 chars | 1 |

## Rhythm

Waveform strip height 100–140, spanning the whole safe area. **At most three per-word highlights** — while the audio is playing, the audience can only spare attention for very few words. The full verbatim transcript goes into the speaker notes.

Write `blueprint.shape` as `audio-waveform`.

## How to place it

```
slidra asset import <id> <audio file path>
slidra element insert audio <id> slides/00N.svg --x 80 --y 230 --width 1120 --height 120 --media assets/<filename>
```

## Variants

- **Multiple segments**: two or three shorter waveform strips stacked vertically, each with its own lead line.
- **With portrait**: a round portrait on the left, waveform on the right — when who is being interviewed matters.
