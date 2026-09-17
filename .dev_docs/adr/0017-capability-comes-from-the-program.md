# ADR-0017 — Capability comes from the program

*Status: in force.*

A workbench governs what may be reached from it: outbound network, how files enter, which
tool servers are available, and the instructions an agent works under. Where those come from
decides what a promise like "this cannot reach the network" is worth.

**Decision.** They come from the program. The skills and the tool-server allow-list ship with
the release and are copied into a workbench when it starts. The rest — network, file entry —
is a policy object the edition selects. A person chooses which agent to use, and nothing else.
**Nothing that grants a capability is ever read from a deck file**, present or not.

**Rejected.**

- **A user-writable policy.** A security boundary a person can widen is not one. The word for
  what a person adjusts for convenience is a setting; this is not that.
- **Skills travelling inside a deck.** A deck arrives from anyone, and a skill is text an agent
  obeys. Slide content is already untrusted (ADR-0007); instructions in the same file have no
  claim to be trusted either.
- **Per-machine skills.** They would make one person's agent behave unlike another's on the
  same deck, and "it works on mine" is the hardest kind of report to act on.

**Consequences.**
- Policy is an object passed in, never a constant, so a closed policy can be selected in tests
  without editing a module that consumes it. Editions differ by which object is chosen.
- A skill fixed in the program reaches every workbench on the next open (ADR-0014), with
  nothing to synchronise.
- **A person cannot extend what their agent knows.** Improving that is a contribution, not a
  local file. This is a real loss, accepted for what a deck from a stranger cannot do.
