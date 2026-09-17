# ADR-0018 — Every call names its caller

*Status: in force.*

A door that listens can be knocked on by anything that can reach it — another program on the
machine, a page open in the browser. And the two editors that come through it do not have the
same rights: an agent must never be handed a real path (ADR-0003), and a deck shown to someone
else must not be writable by them.

**Decision.** Every call carries a credential, and the credential says which kind of caller it
is: the person editing, an agent, or a read-only viewer. A call without one is refused. What a
caller may do is decided at the door, from that credential, not by checks spread through the
handlers behind it.

**Rejected.**

- **Trusting the machine.** It was defensible while nothing listened. It stops being
  defensible the moment the door exists, and the attack needs no privilege — a page the person
  already has open is enough.
- **A single credential, with the caller kind passed as an argument.** Then the caller states
  its own kind, and the one thing the door must not take on faith is exactly that.

**Consequences.**
- Stripping paths out of agent responses becomes the door's job. It was every caller's job to
  remember, which is the shape of a rule that eventually gets forgotten once.
- The viewer kind exists before anything issues one to a person. It is not dead code: the
  render path holds one (ADR-0020), so the read-only case is exercised on every export.
- Issuing credentials is whoever starts the services — locally that is the launcher, and in a
  hosted edition something that has resolved an identity first.
- Sharing a deck for viewing becomes a question of issuing a credential, not of building a
  second read-only path.
