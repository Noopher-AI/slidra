# 21 · civic-plain

**First-impression feel**: Gray-white, olive green, upright and unadorned like a government document. Like a public-information handout — not beautiful, but everyone can read it and no one feels sold to.

**Suited for**: Government, public policy, information sessions, non-profits.
**Not suited for**: Commercial proposals. The style's neutrality reads as a lack of ambition.

**Why this palette**: Olive green is the only identifying color, its saturation deliberately kept low so it "doesn't look like a brand"; everything else is grayscale. The goal of public communication is to be unbiased; any strong color would be read as a position.

```json
{
  "density": "balanced",
  "palette": { "background": "#F7F7F5", "secondary_bg": "#E8E8E4", "primary": "#5A6B4A", "accent": "#8C6A3F", "secondary_accent": "#4A5A6B", "text": "#1F2220", "muted": "#6B6F6B" },
  "type_scale": { "cover": 62, "section": 48, "number": 124, "claim": 42, "title": 36, "subtitle": 25, "body": 22, "column": 20, "caption": 17 },
  "layout": { "side_margin": 80, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "plain",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: A single typeface; the scale runs a touch larger (caption 17 rather than 16) — public audiences have the widest age range, so the smallest text needs headroom.

**Spacing rhythm**: Standard spacing. Density `balanced` — policy explanations have long sentences.

**Suggested backgrounds**: `background: off` recommended. **Light backgrounds** (background library 46–54, drawn for light bases): 48, 51, 52.
