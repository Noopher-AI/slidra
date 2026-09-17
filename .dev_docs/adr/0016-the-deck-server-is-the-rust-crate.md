# ADR-0016 — The deck server is the Rust crate

*Status: in force.*

The binary has always been the only writer of deck content, but the HTTP surface in front of
it was not: the resident mode execs into Node, and Node spawns the binary once per command.
Making that surface the one door (ADR-0015) forces a question it was possible to avoid while
it was only an implementation detail — which of the two is the door.

**Decision.** The server that answers deck calls is the Rust crate itself. Deck work never
leaves Rust: the call arrives, is authorised, and is executed in the same process. Node keeps
what only Node can do — the agent adapters, the sandbox launcher they run inside, and the
browser work (ADR-0020).

**Rejected.** Leaving the door in Node and spawning the binary per call. Smaller to build, and
it leaves a component that sees everything, is trusted completely, and is not where the
writing happens. Authorising in one process and writing in another means two places have to
agree forever. It also pays a process spawn on every command, on top of the round trip
ADR-0015 already costs.

**Consequences.**
- The security-critical component is small enough to read: the same process decides whether a
  caller may touch this deck and then touches it.
- Deck storage, reads, uploads and change events move into the crate. This is the largest
  single piece of work the decision creates, and a half-finished move — two writers — is worse
  than either end state.
- The language boundary now matches the responsibility boundary: Rust owns the deck, Node owns
  the agent. Anything needing both is a call, not a shared module.
