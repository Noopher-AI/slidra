# square-kpi

**Canvas**: 1080×1080 (1:1) **This is not a 16:9 layout**
**Relationship solved**: `none`
**Unit count**: 1
**One line**: A square number: one large centered number, title above, supplement below — a single-share data card.

**When to use it**: A number worth sharing as a standalone card.
**When not to use it**: Multiple metrics — a square can't hold them; use the horizontal `26 kpi-row` instead.

## Wireframe

Full SVG: see `square-kpi.svg` in the same folder.

## Slots

| Slot | Role | Content | Char budget | Lines |
|---|---|---|---|---|
| Title | `label` | | 12 chars | 1 |
| Big number | `label` | centered, very large | 6 chars | 1 |
| Explanation | `label` | | 16 chars | 1 |
| Supplements ×2 | `label` | optional | 12 chars | 1 |
| Source | `label` | | 14 chars | 1 |

## Rhythm

The number is centered, occupying ~20% of the frame height. **The number must come from the author.** Symmetric top and bottom whitespace.

Write `blueprint.shape` as `square-kpi`.

## Setting the canvas

```
slidra presentation canvas set <presentation-id> --width 1080 --height 1080
```

The canvas must be set **before** creating the first page. Non-16:9 canvases **must not use `k = width ÷ 1280` for font size conversion** — that rule only holds for proportional canvases. Use the slot table directly for portrait and square layouts.

## Variants

- **Change indicator**: a small ↑↓ and percentage at the number's upper-right.
- **Dark base**: invert the whole card for a bolder look on dynamic walls.
