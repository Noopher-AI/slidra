# audio-quote

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A quote fills the center of the layout with a narrow playable waveform below it — read the words first, verify with the sound.

**When to use it**: One powerful verbatim quote, with a recording that can back it up.
**When not to use it**: There is no recording. A text-only quote uses 25 `quote-block`.

## Wireframe

Full SVG: see `audio-quote.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Quotation mark | `garnish` | bare `<text>` | — | — |
| Quotation | `label` (`title`–`claim`) | **Must match the recording word for word** | 18 chars/line, ≤ 2 lines | 1–2 |
| Source | `label` (`caption`) | | 18 chars | 1 |
| Waveform strip | `node` (`audio`) | Narrow, placed below the quote | — | — |

## Rhythm

The waveform strip is narrower than the quotation — it is corroboration, not the protagonist. **The quote must be verbatim equal to the recording**; an edited quote with the original audio attached exposes itself on the spot.

Write `blueprint.shape` as `audio-quote`.

## Variants

- **Multiple quotes**: two quotes stacked vertically, each with its own narrow waveform.
- **No waveform**: just a small play icon in a corner, quieter.
