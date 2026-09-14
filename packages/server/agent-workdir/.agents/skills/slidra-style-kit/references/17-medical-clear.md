# 17 · medical-clear

**First-impression feel**: Pure white, steel blue, a touch of mint. Like a clean consultation room — nothing extra, every label legible.

**Suited for**: Healthcare, wellness, clinical data, public health, any context where the cost of a mistake is high.
**Not suited for**: Brand and emotional appeals. It deliberately has no personality.

**Why this palette**: Blue and green are the established visual vocabulary of medical settings (blue = equipment, green = surgery); the palette inherits rather than invents. Red is reserved for warnings and **must never be used as decoration**; the background is pure white because the charts in this field need the most neutral base possible.

```json
{
  "density": "balanced",
  "palette": { "background": "#FFFFFF", "secondary_bg": "#EEF3F7", "primary": "#1C6E8C", "accent": "#C0392B", "secondary_accent": "#3FA796", "text": "#16202A", "muted": "#5E6B76" },
  "type_scale": { "cover": 62, "section": 48, "number": 128, "claim": 42, "title": 36, "subtitle": 25, "body": 22, "column": 20, "caption": 16 },
  "layout": { "side_margin": 88, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "plain",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: A single typeface, hierarchy carried by weight alone. This field doesn't need a typographic personality; it needs to be impossible to misread.

**Spacing rhythm**: Standard spacing. Density `balanced` — health-education content usually has longer sentences.

**Suggested backgrounds**: `background: off` recommended. **Light backgrounds** (background library 46–54, drawn for light bases): 48, 52.
