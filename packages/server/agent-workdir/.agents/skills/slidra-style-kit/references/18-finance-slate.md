# 18 · finance-slate

**First-impression feel**: A slate-gray base, champagne-gold highlights. Like a private bank's annual report — quiet, expensive, never needing to be loud.

**Suited for**: Financial statements, investments, investor briefings, high-net-worth clients.
**Not suited for**: Startups and early-stage products. The style implies "we've been here a long time."

**Why this palette**: Gray is the only subject; gold appears only in numbers and a single thin line. **If gold exceeds 5% of the area it becomes cheap** — the luxury of this palette comes from restraint, not from the gold itself.

```json
{
  "density": "balanced",
  "palette": { "background": "#1C1F24", "secondary_bg": "#282C33", "primary": "#C7A252", "accent": "#C7A252", "secondary_accent": "#6E7784", "text": "#F0F1F3", "muted": "#9198A2" },
  "type_scale": { "cover": 64, "section": 48, "number": 144, "claim": 44, "title": 36, "subtitle": 25, "body": 22, "column": 20, "caption": 16 },
  "layout": { "side_margin": 88, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "typography": { "heading": "Noto Serif TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: Headings in serif; numbers in Inter (its tabular numerals align best). Density `balanced` — financial pages inherently carry more columns.

**Spacing rhythm**: Standard spacing. This style relies on strict column alignment.

**Suggested backgrounds**: 01 `soft-blobs` (opacity 0.3, a barely-there layer of depth).
