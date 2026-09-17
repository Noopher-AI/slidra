# ADR-0009 — Templates replace masters, and a template dies on use

*Status: in force.*

Other tools keep a deck consistent with two layers, where slides hold no background of their
own and are composed with a master at display time. That directly contradicts ADR-0001 and
ADR-0005: a slide opened on its own would be missing its background.

**Decision.** One layer. A template is simply a slide stored in the deck. Creating a slide
from it copies the whole thing; from that instant the two are unrelated. Elements carry a
lock that travels with the copy and protects the scaffolding.

**Rejected.** Master inheritance, in every variant. The hard part is not composition, it is
override arbitration: once a person edits page 5's background, updating the master has to
decide whether that edit survives. Answering that needs per-attribute provenance tracking —
the least testable machinery in this domain, whose failure mode is "my edit disappeared",
which is the most trust-destroying bug there is. Templates plus locking removes the question
rather than answering it.

What masters buy elsewhere, an agent buys here. A person with only a mouse needs a master to
avoid editing thirty backgrounds by hand; a person with an agent says one sentence.

**Consequences.**
- Changing a template does not touch slides already made from it. Re-running a change across
  a deck is an agent task, bundled into one undo step.
- There is no template switching. Swapping templates properly would need a slot concept, which
  is a separate decision nobody has needed yet.
- A template is edited with ordinary commands, because it is an ordinary slide.
- A lock is a boolean, not a mechanism: two checkpoints, the editor and the command entry.
