# vertical-stack

**Canvas**: 1080×1920 (9:16) **This is not a 16:9 layout**
**Relationship solved**: `none`
**Unit count**: 1 + 2–4
**One line**: A vertical stack: claim on top, image in the middle, key points at the bottom — readable in one screen on a phone held in portrait.

**When to use it**: Stories, short-video covers, mobile-first single-page explanations.
**When not to use it**: Horizontal presentations. This layout's aspect ratio only makes sense on a portrait screen.

## Wireframe

Full SVG: see `vertical-stack.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Claim | `label` | at the top, large enough to read | 10 chars/line, ≤ 2 lines | 1–2 |
| Image or video | `node` | middle section, nearly square | — | — |
| Key points ×N | `label` | bottom section, one per line | 14 chars | 1 |
| Account/source | `label` | at the very bottom | 14 chars | 1 |

## Rhythm

**Do not use `k` for font size**: portrait screens are usually viewed up close on a phone; the claim needs 80+ to have impact. The three sections (claim / image / key points) each take about a third, with a large spacing between sections.

Write `blueprint.shape` as `vertical-stack`.

## Setting the canvas

```
slidra presentation canvas set <presentation-id> --width 1080 --height 1920
```

The canvas must be set **before** creating the first page. Non-16:9 canvases **must not use `k = width ÷ 1280` for font size conversion** — that rule only holds for proportional canvases. Use the slot table directly for portrait and square layouts.

## Variants

- **No image**: remove the middle section, let the claim occupy half the frame.
- **Image at top**: the image bleeds to the top edge, the claim sits below it.
