# 14 · academic

**First-impression feel**: Off-white paper, dark red headings, serif type. Like a printed paper — restrained, citation-heavy, not trying to please.

**Suited for**: Research presentations, academic reports, oral exams, white papers.
**Not suited for**: Contexts that need speed or emotion. Its pace is slow.

**Why this palette**: The primary is oxblood red — the color of hardcover book covers and academic robes; the off-white base reduces eye fatigue during long reading sessions; aside from oxblood, there is almost no color — in academic contexts, the visual focus should be on figures and tables, not the layout.

```json
{
  "density": "text",
  "palette": {"background": "#FBF9F4", "secondary_bg": "#EFEBE1", "primary": "#6B1D2B", "accent": "#A8703A", "secondary_accent": "#3F5B6B", "text": "#1F1B18", "muted": "#6E675E"},
  "type_scale": {"cover": 60, "section": 46, "number": 120, "claim": 42, "title": 34, "subtitle": 24, "body": 21, "column": 19, "caption": 16},
  "layout": {"side_margin": 96, "bottom_margin": 80, "footer_margin": 16, "gutter": 28, "spacing": [8, 16, 24, 40, 64]},
  "typography": {"heading": "Source Han Serif TC", "body": "Noto Serif TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: **The entire deck uses serifs** (headings in Source Han Serif TC, body in Noto Serif TC) — this is the only style where body text is also serif, because academic text is expected to be "read," not just "seen." Density `text` allows longer sentences.

**Spacing rhythm**: Standard spacing, wide margins (96). Pages look like book pages, not slides.

**Suggested backgrounds**: `background: off` is recommended. **Light backgrounds** (background library 46–54, designed for light bases): 48, 51, 54.
