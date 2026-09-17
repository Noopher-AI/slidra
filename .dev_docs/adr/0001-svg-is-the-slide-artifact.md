# ADR-0001 — SVG is the slide artifact

*Status: in force.*

Presentation tools normally treat SVG as a way station on the road to PPTX: generated,
converted, discarded.

**Decision.** One SVG *is* one slide — the thing that is edited, stored and played. There is
no more authoritative representation behind it.

**Rejected.** Interoperability with the PowerPoint ecosystem. The app neither imports nor
exports PPTX. What that buys is an artifact humans, agents and browsers all read directly,
with no proprietary format in the middle.

**Consequences.**
- Anything written into a slide must be valid SVG, or the artifact splits into two
  representations that can disagree.
- Opening a single slide in another tool must show the correct static picture. This is the
  acceptance test for whether a design violates this decision.
- Fonts are the one exception, and they have their own record (ADR-0010).
