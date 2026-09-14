# 22 · zine-punk

**First-impression feel**: Xerox-eaten grayscale plus a hit of fluorescent. Like a hand-stapled underground zine — rough, misaligned, deliberately off-kilter.

**Suited for**: Culture, music, subculture, experimental content, art festivals.
**Not suited for**: Contexts requiring trust (medical, finance, legal). Roughness reads as unreliable.

**Why this palette**: The base is xerox-paper gray-white (not white); black is xerox black (#1A1A1A, not pure black); fluorescent pink is the only color, simulating a highlighter mark. **The point of this palette is that it should look a bit dirty.**

```json
{
  "density": "presentation",
  "palette": {"background": "#EFEFEA", "secondary_bg": "#DEDED6", "primary": "#1A1A1A", "accent": "#FF2D78", "secondary_accent": "#00C2A8", "text": "#1A1A1A", "muted": "#5E5E58"},
  "type_scale": {"cover": 84, "section": 64, "number": 160, "claim": 52, "title": 44, "subtitle": 28, "body": 23, "column": 21, "caption": 17},
  "layout": {"side_margin": 64, "bottom_margin": 64, "footer_margin": 16, "gutter": 20, "spacing": [8, 16, 28, 44, 72]},
  "typography": {"heading": "Space Grotesk", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "brutalist",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: Large type sizes, narrow margins (64) — zine layouts are cramped. Titles can press against the margins or even bleed; this is one of the few styles where breaking the rules is allowed.

**Spacing rhythm**: Irregular spacing (8/16/28/44/72), deliberately not proportional.

**Suggested backgrounds**: 02 `dot-grid` (opacity 0.5, like halftone print). **Light backgrounds** (background library 46–54, designed for light bases): 47, 49, 52, 53.
