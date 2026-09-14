# vertical-list

**Canvas**: 1242×1660 (3:4) **This is not a 16:9 layout**
**Relationship solved**: `membership`
**Unit count**: 3–6
**One line**: A vertical numbered list: one title plus a row of horizontal bars — a scrollable knowledge post.

**When to use it**: Illustrated knowledge posts, list-style content, long-form social posts.
**When not to use it**: Situations where everything must be visible at a glance — this aspect ratio assumes the reader will scroll.

## Wireframe

Full SVG: see `vertical-list.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 12 chars | 1 |
| Subtitle | `label` | explains what this post is about | 20 chars | 1 |
| Horizontal bars ×N | `node` (`field`) | equal height | — | — |
| Number | `label` | large, faded | 2 chars | 1 |
| Item title | `label` | | 12 chars | 1 |
| Supplement | `label` | one line | 16 chars | 1 |
| Account/source | `label` | | 14 chars | 1 |

## Rhythm

Bars are equal height with even spacing; five is the sweet spot. **Numbers are large and faded** — they are rhythm markers, not the point. Left and right margins are narrower than 16:9 (the frame is already narrow).

Write `blueprint.shape` as `vertical-list`.

## Setting the canvas

```
slidra presentation canvas set <presentation-id> --width 1242 --height 1660
```

The canvas must be set **before** creating the first page. Non-16:9 canvases **must not use `k = width ÷ 1280` for font size conversion** — that rule only holds for proportional canvases. Use the slot table directly for portrait and square layouts.

## Variants

- **Add images**: a small square image to the left of each item.
- **Two columns**: when there are many items, split into two columns — only works at 3:4; 9:16 is too narrow.
