# 05 · paper-craft

**First-impression feel**: A kraft-paper base, deep brown text, a touch of indigo. Like a workshop's hand-made handbook — fibrous, not polished, but makes you want to reach out and touch it.

**Suited for**: Workshops, handcraft, local brands, food, on-site education.
**Not suited for**: Tech products, financial reports, any context that needs a "precise" impression. The paper feel makes numbers look imprecise.

**Why this palette**: The base is a yellow-leaning kraft color (#EFE6D5), not off-white — that slight gray is the difference: white reads as "clean," gray-yellow reads as "paper"; the deep-brown primary is almost ink color; the indigo accent is the only cool color on the paper, so highlights jump out on their own.

```json
{
  "density": "presentation",
  "palette": {"background": "#EFE6D5", "secondary_bg": "#E2D5BE", "primary": "#4A3728", "accent": "#2F4B7C", "secondary_accent": "#8C6239", "text": "#2B2118", "muted": "#6F6252"},
  "type_scale": {"cover": 68, "section": 52, "number": 132, "claim": 46, "title": 38, "subtitle": 26, "body": 23, "column": 21, "caption": 17},
  "layout": {"side_margin": 72, "bottom_margin": 80, "footer_margin": 16, "gutter": 32, "spacing": [12, 20, 32, 48, 72]},
  "typography": {"heading": "cwTeXKai", "body": "Noto Sans TC", "heading_weight": 400, "body_weight": 400},
  "shape_language": "paper-cut",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: Headings use kaiti (cwTeXKai), body uses gothic. Kaiti has stroke order, giving it a hand-written warmth at a glance — but **do not use kaiti at small sizes**; below 24 it becomes blurry; everything other than titles and section names should be gothic.

**Spacing rhythm**: Loose spacing (12/20/32/48/72), with a larger bottom margin (`bottom_margin` 80). The handmade feel needs whitespace; don't fill the page.

**Suggested backgrounds**: 01 `soft-blobs` (opacity 0.6 or below, like light through paper). **Light backgrounds** (background library 46–54, designed for light bases): 47, 50, 51, 54.
