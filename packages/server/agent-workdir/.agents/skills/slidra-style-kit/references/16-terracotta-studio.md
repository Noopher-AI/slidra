# 16 · terracotta-studio

**First-impression feel**: Terracotta, sand, and a touch of kiln-fired black. Like the walls of a design studio — textured but not tense; the work is the star.

**Suited for**: Design proposals, spatial design, craft brands, portfolios.
**Not suited for**: Data-dense reports. This palette expects images on the page; all text would feel empty.

**Why this palette**: The primary is fired terracotta red — darker than brick, warmer than wine; the sand secondary_bg is very close to the base, so zoning relies on borders rather than contrast; black is only for text, never as a color block — a studio wall would never be pure black.

```json
{
  "density": "presentation",
  "palette": {"background": "#F7F2EC", "secondary_bg": "#EBE0D4", "primary": "#B4552D", "accent": "#D99058", "secondary_accent": "#5C6B5D", "text": "#221D19", "muted": "#7A6E62"},
  "type_scale": {"cover": 72, "section": 54, "number": 140, "claim": 48, "title": 38, "subtitle": 27, "body": 23, "column": 21, "caption": 17},
  "layout": {"side_margin": 88, "bottom_margin": 80, "footer_margin": 16, "gutter": 36, "spacing": [12, 24, 36, 56, 88]},
  "typography": {"heading": "Playfair Display", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "paper-cut",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: English headings in Playfair Display (high-contrast serif, studio signature feel); Chinese in Noto Serif TC 700. Body in gothic.

**Spacing rhythm**: Loose spacing, 88px margins. This style needs lots of whitespace for images.

**Suggested backgrounds**: 01 `soft-blobs` (opacity 0.5). **Light backgrounds** (background library 46–54, designed for light bases): 46, 47, 50, 51, 54.
