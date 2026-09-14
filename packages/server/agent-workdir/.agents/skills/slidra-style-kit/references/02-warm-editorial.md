# 02 · warm-editorial

**First-impression feel**: Cream-colored paper, deep wine-red text, orange-brown highlights. Like a beautifully printed cookbook or cultural magazine interior page — warm, tactile; the type looks "typeset" rather than "exported."

**Suited for**: Food, travel, culture, brand stories, education, any context where you want the audience to relax.
**Not suited for**: Financial reports, technical specs, contexts needing dense numbers and charts — the warm base makes dense data look noisy.

**Why this palette**: The base is not pure white but a yellow-tinted off-white (#FAF6F0); pure white is too harsh and too cold on a projector. The wine-red primary is the source of the "printed" feel; the accent's orange-brown is in the same tonal family as the base, so highlights look like they were always part of the paper, not applied on top.

```json
{
  "density": "presentation",
  "palette": { "background": "#FAF6F0", "secondary_bg": "#EDE7DD", "primary": "#7B2D26", "accent": "#C8651B", "secondary_accent": "#3E5C4B", "text": "#1A1A1A", "muted": "#6B6560" },
  "type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 },
  "layout": { "side_margin": 64, "bottom_margin": 72, "footer_margin": 16, "gutter": 32, "spacing": [12, 24, 32, 48, 72] },
  "typography": { "heading": "Noto Serif TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "paper-cut",
  "visual": "editorial-tech"
}
```

**Type-scale contrast**: Same type scale as 01, but **headings in serif, body in sans-serif** — the contrast comes from the typeface, not the size. This is the most important thing about this style; changing only the palette without changing the fonts loses half its character.

**Spacing rhythm**: Spacing is looser than 01 (12/24/32/48/72), and the side margin narrows to 64 to widen the content area. The paper feel needs whitespace; 3–4 units per page is enough.

**Suggested backgrounds**: 01 (soft blobs, works on all pages). Dot grid on a warm base looks like graph paper; not recommended. **Light backgrounds** (background library 46–54, designed for light bases): 46, 47, 50, 51, 54.
