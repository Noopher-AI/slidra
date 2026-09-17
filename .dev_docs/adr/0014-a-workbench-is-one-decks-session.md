# ADR-0014 — A workbench is one deck's session

*Status: in force.*

Once deck content is reached across a boundary (ADR-0015), calls need something to name. A
path cannot be it: a hosted edition has no path to give, and an agent must never see one
(ADR-0003).

This record settles how many decks a workbench holds and how long it lives. They are one
decision, not two: because a workbench holds one deck it needs nothing that outlives the
session, and because it does not outlive the session there is never a second deck to call the
current one. Either half alone leaves the other unanswered.

**Decision.** The unit named by every call is a **workbench**: exactly one deck, plus the
policy it runs under. It is created when that deck is opened and destroyed when the session
ends. The deck file itself is untouched by opening and closing — it is edited in place, as
ADR-0011 requires.

**Rejected.**

- **A workbench holding several decks.** It forces someone to answer "which one is current",
  which is the state that makes a service stateful. With one deck per workbench, switching is
  a call naming a different workbench and there is no state machine to get wrong.
- **A workbench that outlives the session.** Nothing needs to survive in it. The deck file
  carries the deck, its history and its conversation (ADR-0011); everything else in a
  workbench comes from the program (ADR-0015). A persistent workbench would be a second place
  for state to drift.

**Consequences.**
- Locks and turn ownership are scoped to a workbench, not to a process.
- Because a workbench is rebuilt on every open, an upgrade takes effect the next time a deck
  is opened. There is no synchronisation step and nothing to migrate.
- A hosted edition, whose deck cannot be a local file, will need its workbench to persist.
  That is a different lifetime behind the same interface, and a decision for that edition.
