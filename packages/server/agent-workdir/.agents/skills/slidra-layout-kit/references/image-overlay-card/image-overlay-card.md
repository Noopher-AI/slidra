# image-overlay-card

**Relationship solved**: `none`
**Unit count**: 1
**One line**: A full-bleed image with an offset card on top, text inside the card — accommodates more lines than 23 `image-full-bleed`.

**When to use it**: A highly atmospheric image, but the text is more than one line.
**When not to use it**: The image itself is information-dense (charts, screenshots) — the card would cover important parts.

## Wireframe

Full SVG: see `image-overlay-card.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Image | `node` (`image`) | full-bleed | — | — |
| Card | `field` | **doubles as the scrim** | — | — |
| Title | `label` | inside the card | 14 chars | 1 |
| Body | `label` | | 20 chars each | 2–4 lines |

## Rhythm

The card occupies ~40% of the layout, flush to one side (usually right, since background recipes place their highlight on the right too). One `side_margin` between the card and the canvas edge. **The card must be opaque or opacity ≥ 0.85** — a semi-transparent card over a complex image is unreadable.

Write `blueprint.shape` as `image-overlay-card`.

## Variants

- **Bleed card**: card flush to the right edge, only top/bottom margins — more modern.
- **Left card**: when the image's subject is on the right, place the card on the left.
