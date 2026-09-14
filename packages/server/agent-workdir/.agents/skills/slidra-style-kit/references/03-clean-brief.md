# 03 · clean-brief

**First-impression feel**: White base, deep blue, almost no decoration. Like a consulting deck that doesn't want to be remembered for its appearance — it just wants to be trusted for its content. Restrained to the point of boredom, and that is the point.

**Suited for**: Consulting decks, internal reports, proposals, board meetings, any context where "the cost of looking wrong is greater than the benefit of looking great."
**Not suited for**: Contexts that need emotion and a memorable hook (keynotes, recruiting, branding). It will not surprise you; that is a design trade-off.

**Why this palette**: The base is a gray-tinted white (#FCFCFD) rather than pure white, to avoid clashing with projector glare; the primary is a low-saturation deep blue that looks like an institution rather than a brand; accent is used almost exclusively on numbers and one underline, keeping total colored area under 5% of the deck.

```json
{
  "density": "balanced",
  "palette": { "background": "#FCFCFD", "secondary_bg": "#F1F3F6", "primary": "#1F3A5F", "accent": "#C8102E", "secondary_accent": "#4A7C59", "text": "#14181D", "muted": "#5E6773" },
  "type_scale": { "cover": 64, "section": 48, "number": 120, "claim": 44, "title": 36, "subtitle": 26, "body": 22, "column": 20, "caption": 16 },
  "layout": { "side_margin": 96, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "swiss-minimal",
  "visual": "editorial-tech"
}
```

**Type-scale contrast**: One step smaller than 01/02 overall (title 36, body 22), density changed to `balanced` — this context naturally puts more text per page; rather than squeezing, the type scale is reduced and the margins widened (`side_margin` 96).

**Spacing rhythm**: Spacing is restrained (8/16/24/32/56), no big jumps. This style relies on alignment and consistency, not on rhythm variation.

**Suggested backgrounds**: 02 (dot grid, opacity kept below 0.3). In most cases **`background: off` is recommended** — this style's persuasiveness comes from cleanliness. **Light backgrounds** (background library 46–54, designed for light bases): 48, 52.
