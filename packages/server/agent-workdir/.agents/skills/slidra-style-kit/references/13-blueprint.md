# 13 · blueprint

**First-impression feel**: Deep navy base with thin white grid lines, like an unrolled engineering blueprint. Precise, systematic — every line has a reason.

**Suited for**: Architecture explanations, engineering processes, system design, architecture and manufacturing.
**Not suited for**: Emotional appeals, brand stories. The blueprint language only speaks "how it works," not "why it matters."

**Why this palette**: The base is blueprint indigo (#12284C); lines and text are near-white light blue — this palette comes from photograms, so no third color; the orange accent is only for "attention" points, minimal area.

```json
{
  "density": "balanced",
  "palette": {"background": "#12284C", "secondary_bg": "#1B3763", "primary": "#7FB3FF", "accent": "#FF9F45", "secondary_accent": "#A9C9F0", "text": "#EAF1FB", "muted": "#8FA6C4"},
  "type_scale": {"cover": 64, "section": 50, "number": 132, "claim": 44, "title": 36, "subtitle": 26, "body": 22, "column": 20, "caption": 16},
  "layout": {"side_margin": 72, "bottom_margin": 64, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 32, 56]},
  "typography": {"heading": "IBM Plex Mono", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400},
  "shape_language": "data-dense",
  "visual": "editorial-tech"
}
```

**Typography and contrast**: Monospace IBM Plex Mono for English labels and numbers (the language of technical drawing); Chinese in Noto Sans TC. Density `balanced` — architecture diagrams need more labels.

**Spacing rhythm**: Tight spacing (8/16/24/32/56). In a world of grid lines, spacing should be divisible.

**Suggested backgrounds**: 02 `dot-grid` (this style almost requires it; opacity 0.6).
