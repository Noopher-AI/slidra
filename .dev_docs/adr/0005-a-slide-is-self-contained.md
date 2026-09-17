# ADR-0005 — A slide is self-contained

*Status: in force.*

**Decision.** Everything a single slide needs — graphics, identifiers, display names, its
effect list, its transitions, its comments — is written into that slide's own SVG. The
deck-level record keeps only what is meaningful across slides: format version, name, canvas,
and the order of slides.

**Rejected.** Keeping motion or shared styling at deck level, which reads as the tidier
factoring until you try to reorder.

The move that decides this is swapping two slides. If effect lists lived at deck level, or if
step numbers accumulated across slides, reordering would mean editing a second file or
renumbering a whole range. Self-contained, it is swapping two strings in an order array and
touching no slide at all.

**Consequences.**
- Step numbering is scoped to one slide. Step 1 of slide 3 and step 1 of slide 5 are unrelated.
- "How many steps does this deck have" exists in no file. It is derived by scanning, because a
  stored total is a cache, and caches drift.
- Copying a slide carries its motion, transitions and comments with it, by construction.
