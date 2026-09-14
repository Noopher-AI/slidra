# 23 · sky-brief

**First-impression feel**: Very light sky blue to white, almost weightless. Like looking out an airplane window — open, clean, with a sense of distance.

**Suited for**: Travel, aviation, cloud services, any topic related to "movement" or "scale."
**Not suited for**: Content requiring intimacy or detail. It's too open — details get diluted.

**Why this palette**: The blue has very high lightness and medium saturation, so it reads as "air" not "brand blue"; the accent uses warm orange, the color of a horizon; text uses dark blue-gray rather than black, keeping the whole thing in the same color temperature.

```json
{
  "density": "presentation",
  "palette": {"background": "#F5FAFD", "secondary_bg": "#E3F0F8", "primary": "#2E86C1", "accent": "#F39C3D", "secondary_accent": "#7FB3D5", "text": "#1B2A38", "muted": "#6D8296"},
  "type_scale": {"cover": 70, "section": 54, "number": 140, "claim": 46, "title": 38, "subtitle": 27, "body": 23, "column": 21, "caption": 17},
  "layout": {"side_margin": 96, "bottom_margin": 80, "footer_margin": 16, "gutter": 32, "spacing": [12, 20, 32, 48, 80]},
  "typography": {"heading": "Inter", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "glass",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: English and numbers in Inter, Chinese in Noto Sans TC. Both fonts are neutral — this style's character comes from color and whitespace, not typeface.

**Spacing rhythm**: Loose spacing, 96px margins. The sense of openness needs margins.

**Suggested backgrounds**: 01 `soft-blobs` (opacity 0.6, like clouds). **Light backgrounds** (background library 46–54, designed for light bases): 46, 49, 50, 52, 53.
