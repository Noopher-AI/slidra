# SVG is the slide artifact, not an intermediate product

> **⚠️ Partially superseded.** The acceptance criterion "a static view must render correctly when a single slide is opened in another tool" has been given an explicit exception for **fonts** by **ADR-0016**: a CJK presentation font is a single sfnt file of roughly 5.6MB, and embedding it into every SVG (base64, uncompressed) is not viable — see the trade-off discussion in ADR-0016. A slide opened on its own degrades to the browser's system font; the presentation's actual specified font is only guaranteed when played or edited through the app itself (`serve` or its wrapper).
>
> **Everything else** — a slide must be valid SVG, and non-font graphics and colors must not depend on external resources — is unaffected.

Tools like typical presentation generators use SVG as a waypoint on the way to PPTX, discarding the SVG once it has served its purpose. This project inverts that: an SVG *is* a slide. It is the thing that gets edited, saved, and played — there is no more authoritative representation behind it.

This choice gives up compatibility with the PowerPoint ecosystem — the app neither imports nor exports PPTX. In exchange, it gets an artifact that a person, an agent, and a browser can all understand directly, with no proprietary format acting as an intermediary.

## Consequences

- Anything saved into a slide must be valid SVG, or the artifact splits into two disagreeing representations.
- Opening a single slide in another tool (a browser, Illustrator, Figma) must render a correct static view. This is the acceptance test for whether a design violates this decision. **Fonts are the exception, see the banner above and ADR-0016** — when `font-family` can't find a matching font, the browser falls back to a system font per the CSS font-stack rules; the view won't break, but it's not guaranteed to match the original font pixel for pixel.
