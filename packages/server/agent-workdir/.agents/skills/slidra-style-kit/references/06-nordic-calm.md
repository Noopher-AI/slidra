# 06 · nordic-calm

**First-impression feel**: A gray-blue white, text with almost no visible saturation. Like a Nordic winter afternoon — quiet, cool, saying nothing extra. The whitespace is itself the content.

**Suited for**: Design proposals, product philosophy, contexts that need to "hold steady."
**Not suited for**: Contexts needing enthusiasm or urgency (fundraising, promotions, rallies). It is too calm.

**Why this palette**: The entire set is kept under 20% saturation — the primary is gray-blue, not blue; the accent is a muted orange, not orange. This is the only palette where "no color wants to be seen," so the layout's whitespace and alignment become the only visual focus; if done poorly, there is nowhere to hide.

```json
{
  "density": "presentation",
  "palette": {"background": "#F4F6F7", "secondary_bg": "#E6EAEC", "primary": "#5C7A8C", "accent": "#C98B6B", "secondary_accent": "#8FA396", "text": "#2A3236", "muted": "#7C888E"},
  "type_scale": {"cover": 64, "section": 48, "number": 120, "claim": 42, "title": 34, "subtitle": 24, "body": 21, "column": 19, "caption": 16},
  "layout": {"side_margin": 112, "bottom_margin": 88, "footer_margin": 16, "gutter": 40, "spacing": [16, 24, 40, 64, 96]},
  "typography": {"heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 400, "body_weight": 400},
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: **Headings are not bold** (weight 400) — this is the most counterintuitive and most crucial point of this style. Hierarchy is built through type scale and whitespace, not weight. Bolding would destroy it immediately.

**Spacing rhythm**: The loosest spacing set (16/24/40/64/96), margins of 112. At most 3 units per page; split into more pages if needed.

**Suggested backgrounds**: 01 `soft-blobs` (opacity 0.4 or below) or simply `background: off`. **Light backgrounds** (background library 46–54, designed for light bases): 48, 52.
