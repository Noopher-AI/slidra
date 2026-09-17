# ADR-0015 — The deck server is the crate, and there is no way round it

*Status: in force.*

The binary has always been the only writer of deck content, but the surface in front of it was
not: the resident mode execs into Node, Node spawns the binary once per command, and the
editor reaches deck content in the process that serves it. That was invisible while everything
ran on one machine. It stops being invisible the moment the parts must be restarted, scaled or
audited separately.

**Decision.** The server that answers deck calls is the Rust crate itself: a call arrives, is
authorised, and is executed in one process. Everything reaches it the same way — the editor,
the agent, the renderer — across a process boundary, on one machine and on many. **There is no
in-process path and no local shortcut.**

**Rejected.**

- **Leaving the door in Node and spawning the binary per call.** Smaller to build, and it
  leaves a component that sees everything, is trusted completely, and is not where the writing
  happens. Authorising in one process and writing in another means two places must agree
  forever — and it pays a process spawn on top of the round trip.
- **Keeping an in-process path for local use.** It is faster, and that is the whole argument
  for it. The cost is that the local edition would exercise one path and every other edition
  the other, so the path a hosted edition depends on would be exercised by nobody who uses the
  product daily. A shortcut is not a shortcut if it is the only route anyone tests.

**Consequences.**
- The security-critical component is small enough to read: the same process decides whether a
  caller may touch this deck and then touches it.
- ADR-0002's invariant is now enforced by the boundary rather than by a shared dispatch: the
  frontend cannot reach deck content at all except by a call anyone can inspect.
- Deck storage, reads, uploads and change events move into the crate. This is the largest piece
  of work the decision creates, and a half-finished move — two writers — is worse than either
  end state.
- The language boundary now matches the responsibility boundary: Rust owns the deck, Node owns
  the agent. Anything needing both is a call, not a shared module.
- **Every command pays a round trip, and a turn issues dozens.** This is the price; it is worth
  measuring rather than assuming.
- The server becomes a single point of failure. Nothing can be edited while it is down.
