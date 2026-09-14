# 20 · luxury-noir

**First-impression feel**: All black, champagne white, extremely thin type. Like the last page of a luxury-brand ad — whitespace outnumbers content, and that is the message.

**Suited for**: Branding, luxury goods, companion decks for image films, openers and closers.
**Not suited for**: Any page that needs to explain detail. It can only carry one sentence per page.

**Why this palette**: There is no middle tone between black and off-white; the only third color is a thin line of champagne gold. **This style forbids color blocks** — all zoning is done with whitespace and lines.

```json
{
  "density": "presentation",
  "palette": { "background": "#000000", "secondary_bg": "#0E0E0E", "primary": "#D9C9A8", "accent": "#D9C9A8", "secondary_accent": "#7A7267", "text": "#F5F1E8", "muted": "#8C857A" },
  "type_scale": { "cover": 88, "section": 64, "number": 168, "claim": 56, "title": 44, "subtitle": 28, "body": 24, "column": 22, "caption": 17 },
  "layout": { "side_margin": 120, "bottom_margin": 96, "footer_margin": 16, "gutter": 40, "spacing": [16, 32, 56, 88, 128] },
  "typography": { "heading": "Playfair Display", "body": "Noto Serif TC", "heading_weight": 400, "body_weight": 400 },
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: **No bold** (weight 400); the type scale wins by size. English in Playfair Display's high-contrast serif; Chinese in Noto Serif TC.

**Spacing rhythm**: The largest spacing; 120px margins. One unit per page.

**Suggested backgrounds**: `background: off` is recommended, or 01 `soft-blobs` at opacity 0.25.
