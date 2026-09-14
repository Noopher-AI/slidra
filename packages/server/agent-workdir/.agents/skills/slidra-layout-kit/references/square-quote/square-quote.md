# square-quote

**Canvas**: 1080×1080 (1:1) **This is not a 16:9 layout**
**Relationship solved**: `none`
**Unit count**: 1
**One line**: A square quote: one line centered slightly above, source below — the single card most suited to being shared.

**When to use it**: A powerful verbatim quote, a pull-quote card, a series of memorable lines.
**When not to use it**: Content that needs explanation. Square space can't hold an argument.

## Wireframe

Full SVG: see `square-quote.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Quotation mark | `garnish` | | — | — |
| Quotation | `label` | ≤ 2 lines | 10 chars/line | 1–2 |
| Short line | `garnish` | | — | — |
| Source | `label` | | 14 chars | 1 |
| Account/handle | `label` | at the very bottom | 14 chars | 1 |

## Rhythm

The quote hugs the left edge, vertically centered slightly above middle (visual center is higher than geometric center). The square's margins must be uniform on all four sides, or it looks crooked.

Write `blueprint.shape` as `square-quote`.

## Setting the canvas

```
slidra presentation canvas set <presentation-id> --width 1080 --height 1080
```

The canvas must be set **before** creating the first page. Non-16:9 canvases **must not use `k = width ÷ 1280` for font size conversion** — that rule only holds for proportional canvases. Use the slot table directly for portrait and square layouts.

## Variants

- **Centered version**: quote horizontally centered, more poster-like.
- **With portrait**: a round portrait in the upper-left.
