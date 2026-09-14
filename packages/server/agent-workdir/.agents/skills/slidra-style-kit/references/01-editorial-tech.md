# 01 · editorial-tech

**First-impression feel**: Dark base, cool color temperature, high type-scale contrast. Like a well-typeset technical article in dark mode — quiet, precise, not flashy; information density can go high without looking chaotic.

**Suited for**: Product explanations, tech talks, developer events, any "the audience is professionals" context.
**Not suited for**: Children's education, crafts & food, brand stories that need warmth and intimacy. The dark base makes these topics feel distant.

**Why this palette**: The background is not pure black but a blue-tinted dark gray (#101418); pure black loses depth on a projector. The primary is a high-luminance blue that stays readable on a dark base; accent uses warm yellow — a warm point on a cool base is what creates breathing room.

```json
{
  "density": "presentation",
  "palette": { "background": "#101418", "secondary_bg": "#1B2129", "primary": "#4F8DFF", "accent": "#F5B942", "secondary_accent": "#6DD3A5", "text": "#F4F6F8", "muted": "#9AA7B4" },
  "type_scale": { "cover": 72, "section": 56, "number": 140, "claim": 48, "title": 40, "subtitle": 28, "body": 24, "column": 22, "caption": 18 },
  "layout": { "side_margin": 80, "bottom_margin": 72, "footer_margin": 16, "gutter": 24, "spacing": [8, 16, 24, 40, 64] },
  "typography": { "heading": "Noto Sans TC", "body": "Noto Sans TC", "heading_weight": 700, "body_weight": 400 },
  "shape_language": "plain",
  "visual": "editorial-tech"
}
```

**Type-scale contrast**: Title 40 vs body 24, ratio 1.67 — moderate contrast; the title leads without overpowering the content. The 140 number is the only high note; use it once per deck.

**Spacing rhythm**: Spacing is on the denser side (8/16/24/40/64), suitable for 3–5 units per page. If you want more air, switch styles — don't just change the spacing; density is part of this style's identity.

**Suggested backgrounds**: 02 (dot grid, content pages), 03 (diagonal beams, anchor pages). Soft blobs will smudge on this dark base; not recommended.
