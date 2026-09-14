# 08 · soft-pastel

**First-impression feel**: Pink lotus, mint, cream white. Round, soft, no sharp corners. Like the interior pages of a children's book — safe, friendly, easy on the eyes for a long time.

**Suited for**: Education, children, community building, any context where you want the audience to lower their guard.
**Not suited for**: Professional assessments, finance, crisis communication. Softness reads as not serious enough.

**Why this palette**: All three hues sit around 40% saturation with high lightness — no color dominates another, so the frame has no oppressive focal point. Text is dark gray rather than black; pure black is too harsh on pale pastels.

```json
{
  "density": "presentation",
  "palette": {"background": "#FFF9F5", "secondary_bg": "#FDEDE6", "primary": "#E89BA5", "accent": "#F2A65A", "secondary_accent": "#7FC8A9", "text": "#3D3636", "muted": "#8C8080"},
  "type_scale": {"cover": 68, "section": 52, "number": 132, "claim": 46, "title": 38, "subtitle": 27, "body": 24, "column": 22, "caption": 18},
  "layout": {"side_margin": 80, "bottom_margin": 80, "footer_margin": 16, "gutter": 32, "spacing": [12, 20, 32, 48, 72]},
  "typography": {"heading": "jf open 粉圓", "body": "jf open 粉圓", "heading_weight": 700, "body_weight": 400},
  "shape_language": "soft-rounded",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: The whole deck uses a rounded gothic (JF Open 粉圓). **The rounded face is half of this style** — change only the palette and it becomes an ordinary light deck. Headings are distinguished by weight (700), not by switching families.

**Spacing rhythm**: Loose spacing (12/20/32/48/72). Rounded faces have larger glyph boxes; 24 body is enough.

**Suggested backgrounds**: 01 `soft-blobs` (opacity 0.7, matching the soft temperament). **Light backgrounds** (background library 46–54, designed for light bases): 46, 47, 49, 50, 52.
