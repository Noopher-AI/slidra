# ADR-0015 — Deck content is reached across a boundary, locally too

*Status: in force.*

ADR-0002 makes the CLI the only vocabulary, but the editor has always reached deck content in
the same process that serves it. That is enough on one machine and impossible anywhere else:
an edition that must restart, scale or audit its parts separately needs them to be separate
parts.

**Decision.** Deck content is reached only by calling a server across a process boundary —
from the editor and from the agent alike, on one machine and on many. There is no in-process
path and no local fast path.

**Rejected.**

- **Keeping the in-process path for local use.** It is faster and it costs nothing to keep,
  which is exactly the problem: the local edition would exercise one path and any other
  edition the other, so the boundary would be tested by nobody who runs the product daily.
- **A boundary only where it is needed.** The agent already goes through one; adding the
  editor to it is what makes "the frontend can only do what the CLI can do" enforced by the
  network rather than by everyone remembering.

**Consequences.**
- The invariant in ADR-0002 is now structural in a stronger way than a shared dispatch made
  it: the frontend cannot reach deck content at all except by a call anyone can inspect.
- **Every command pays a round trip, and a turn issues dozens.** This is the price the
  decision was bought at; it is worth measuring rather than assuming.
- The server becomes a single point of failure. Nothing can be edited while it is down.
- The door is now the place where a caller can be refused, which is what ADR-0018 needs.
