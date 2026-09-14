# 04 · midnight-lab

**First-impression feel**: A near-black base with a single fluorescent cyan. Like a lab monitor still lit at midnight — focused, cold, slightly lonely. Information can be packed very dense without feeling noisy.

**Suited for**: Research findings, data analysis, monitoring dashboards, deep technical topics.
**Not suited for**: Explanations for a general audience, brand stories that need warmth. This palette makes people feel "this isn't talking to me."

**Why this palette**: The base is pushed down to #0A0C10 for that "screen" feel; the primary is a high-saturation cyan, the only color that glows on near-black; the accent lime green is reserved for numbers and warnings, kept under 3% of the area — more and it becomes esports.

```json
{
  "density": "presentation",
  "palette": {"background": "#0A0C10", "secondary_bg": "#141A22", "primary": "#22D3EE", "accent": "#A3E635", "secondary_accent": "#818CF8", "text": "#E8EDF2", "muted": "#7C8794"},
  "type_scale": {"cover": 68, "section": 52, "number": 150, "claim": 46, "title": 38, "subtitle": 26, "body": 22, "column": 20, "caption": 16},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56]},
  "typography": {"heading": "IBM Plex Mono", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "data-dense",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: Headings use the monospace IBM Plex Mono, body uses Noto Sans TC. Monospace makes the title look like terminal output — that is the source of this style and its only decoration. **Do not use IBM Plex Mono for Chinese titles** (it has no CJK glyphs); use Noto Sans TC 700 for Chinese headings.

**Spacing rhythm**: Tight spacing (8/16/24/32/56), and the type scale is one step smaller than 01 overall. This style expects a lot on one page.

**Suggested backgrounds**: 02 `dot-grid` (best match — the grid looks like an oscilloscope). Blobs and beams are too soft; not recommended.
