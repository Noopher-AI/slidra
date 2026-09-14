# 25 · spectrum-data

**First-impression feel**: Neutral light gray base paired with a set of mutually distinguishable category colors. Designed specifically for "this page has charts" — the layout recedes to the back, data is the only star.

**Suited for**: Dashboards, data presentations, research data, any page with more than one chart.
**Not suited for**: Pages without charts. Without charts, this palette looks personality-less — which is by design.

**Why this palette**: Four of the six roles are **category colors** (blue/orange/green/purple), spaced far enough apart on the hue wheel, colorblind-friendly, with similar lightness so no single line appears more important. Background and text are deliberately neutral, not competing with data.

```json
{
  "density": "balanced",
  "palette": {"background": "#FAFAFB", "secondary_bg": "#EEF0F3", "primary": "#2E6FD9", "accent": "#E8833A", "secondary_accent": "#2AA07A", "text": "#1A1D21", "muted": "#6B7280"},
  "type_scale": {"cover": 62, "section": 48, "number": 132, "claim": 42, "title": 36, "subtitle": 25, "body": 21, "column": 19, "caption": 15},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56]},
  "typography": {"heading": "Inter", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "data-dense",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: Numbers and axis labels always use Inter (monospace numerals align best). `caption` is only 15 — chart axis labels need to be small to not dominate.

**Spacing rhythm**: Tight spacing, narrow margins (72), giving space to the charts.

**Suggested backgrounds**: `background: off` recommended; any background texture on chart pages interferes with reading data. **Light backgrounds** (background library 46–54, designed for light bases): 48, 49, 52.
