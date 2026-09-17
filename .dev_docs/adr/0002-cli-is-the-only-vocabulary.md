# ADR-0002 — The CLI is the only vocabulary

*Status: in force.*

The product serves two kinds of editor: a person in a visual editor and an agent in a shell.
Give them separate interfaces and their capabilities drift apart, at which point they can no
longer work on the same deck.

**Decision.** Every operation the product supports is defined by one CLI command. The
frontend may never have a capability the CLI lacks.

**Rejected.** Letting the frontend call a shared core directly. Fast enough, but it demotes
the invariant from structural to disciplinary, and disciplinary invariants decay.

**Consequences.**
- The command set *is* the product specification. Adding a command adds a user-visible
  capability, so it is a product decision, not a refactor.
- One gesture equals one command equals one undo step. Dragging is a local preview until the
  gesture ends.
- Styling is a deliberate exception: one generic command named after the underlying
  attributes, gated by an allow-list, because twenty style commands would make the set too
  long for anyone to read.

*What the command set contains lives in `docs/spec/cli.md`.*
