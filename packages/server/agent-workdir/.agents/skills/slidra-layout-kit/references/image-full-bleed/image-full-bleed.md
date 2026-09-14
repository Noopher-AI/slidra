# image-full-bleed

**Relationship solved**: `none`
**Unit count**: 1
**One line**: One image fills the entire page with text layered on top — the most dramatic, but also the easiest to make unreadable.

**When to use it**: Section transitions, openings, or when a single image is itself the statement.
**When not to use it**: Any page that needs multiple lines of readable text.

## Wireframe

Full SVG: see `image-full-bleed.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Image | `node` (`image`) | full-bleed | — | — |
| Scrim | `field` | **required**, covering all text | — | — |
| Claim | `label` (`claim`) | | 22 chars | 1–2 |
| Supplement | `label` | optional | 20 chars | 1 |

## Rhythm

**Scrim is not optional**: text on an image without a base will be unreadable, and `validate`'s `structure.scrim` will flag it. A one-direction gradient scrim (from opaque to transparent) looks more natural than a solid color block. Keep text concentrated in the lower half or one side, not scattered.

Write `blueprint.shape` as `image-full-bleed`.

## Variants

- **Top-press**: text at the top edge, scrim fading from top to bottom.
- **Side panel**: a 40%-wide scrim column on the right, text placed inside it.
