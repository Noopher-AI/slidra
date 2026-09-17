# ADR-0006 — Motion is an ordered list of effects

*Status: in force.*

**Decision.** Each slide carries an ordered list of effects. Every entry points at exactly one
element and carries its own family, start trigger and timing. The list is written in the
slide's own markup, in the same syntax as the rest of the file.

**Rejected.** Expressing motion as attributes on the elements themselves. The ceiling is
structural: one element can hold one effect, so "appear at step 2, emphasise at 5, leave at 7"
is inexpressible without inventing a mini-language inside an attribute value. A list makes
inserting an effect in the middle an array insert.

This is the shape both major presentation tools use, and for the same reason: they keep motion
in a structure separate from the shape tree, pointing back at shapes by identifier.

**Consequences.**
- Steps are no longer stored. They are derived by grouping entries on their start triggers.
- Every entry must point at an element. Audio therefore hangs on a visible element too.
- Deleting an element leaves dangling entries that must be cleaned. This is the one new
  failure mode the decision introduces.
- Embedding the list as markup rather than embedded JSON keeps the file one syntax, so no
  reader switches parsers halfway through.
