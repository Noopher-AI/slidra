# ADR-0010 — Fonts are packaged; a standalone slide degrades

*Status: in force.*

CJK text cannot be measured or rendered consistently without the font being present, and both
the layout engine and the browser must measure identically or the picture shifts between
editing and playback.

**Decision.** Fonts travel inside the deck, with their licence text. Slides reference them by
family name only. A slide opened outside the app falls back to system fonts.

**Rejected.** Embedding the font in each slide as encoded data. A CJK face is several
megabytes before encoding, and the cost multiplies by slide count. It would not even achieve
self-containment — it trades one external dependency for another — while breaking the
single-file promise (ADR-0011) and the lean-output rule (ADR-0003).

**Consequences.**
- This is the one and only exception to ADR-0001. A standalone slide stays valid and readable;
  it is not guaranteed pixel-identical.
- Text measurement must fail loudly when a font is missing. A guessed width makes every
  downstream layout number untrustworthy, silently.
- A font is packaged once per deck no matter how many slides use it.
