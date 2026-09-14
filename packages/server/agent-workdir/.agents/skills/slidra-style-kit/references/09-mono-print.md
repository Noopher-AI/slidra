# 09 · mono-print

**First-impression feel**: Pure black and white, with exactly one red. Like an uncolored newspaper front page — information first, design in the back, but every alignment is calculated.

**Suited for**: Investigative reporting, fact presentation, contexts that need "I'm not dressing this up."
**Not suited for**: Product launches, brand image. It looks too much like evidence, not like an invitation.

**Why this palette**: Outside black and white, only one red remains, and the red is **used in exactly one place** (usually one number or one keyword). Two reds on a page and this style collapses. secondary_bg is a very pale gray, used for zoning rather than decoration.

```json
{
  "density": "balanced",
  "palette": {"background": "#FFFFFF", "secondary_bg": "#F0F0F0", "primary": "#000000", "accent": "#D0021B", "secondary_accent": "#666666", "text": "#111111", "muted": "#767676"},
  "type_scale": {"cover": 64, "section": 48, "number": 128, "claim": 44, "title": 36, "subtitle": 25, "body": 21, "column": 19, "caption": 15},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64]},
  "typography": {"heading": "Noto Serif TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "brutalist",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: Headings in serif, body in gothic — newspaper typesetting logic. Density is `balanced`, because this context naturally carries more text.

**Spacing rhythm**: Standard spacing (8/16/24/40/64). This style relies on strict alignment, not rhythm variation.

**Suggested backgrounds**: `background: off` is recommended. If you must use one, 02 `dot-grid` at opacity 0.2 or below. **Light backgrounds** (background library 46–54, designed for light bases): 48, 51, 54.
