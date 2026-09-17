# ADR-0003 — Deck content is read-only to agents

*Status: in force.*

ADR-0002 requires every change to go through a semantic command. But an agent that can see a
real file path will reach for it — reading and writing are the same reach, and discipline
does not stop it.

**Decision.** The app never exposes a real filesystem to an agent. The CLI presents a virtual
view of deck content: the agent can see everything and write nothing. Writes are refused with
an error naming the command to use instead.

**Rejected.** Trusting the agent not to look. Once a real path is printed even once, it will
be tried.

**Consequences.**
- Taking away file reading means giving it back deliberately: listing, reading and searching
  must exist as commands, or every inspection costs a full read of every slide.
- The person is not the one being restricted. An explicit extract command returns their own
  files at any time — the deck is a container, not a cage.
- Elements are addressed by opaque stable identifiers, with display names stored separately.
- Output size is conversation cost, so generated SVG stays lean.

*What the gate blocks, and the OS-level isolation behind it, are implementation: both have changed
several times without this decision changing, and neither is recorded as a decision.
`docs/spec/workspace.md` specifies what `SLIDRA_HOME` holds.*
