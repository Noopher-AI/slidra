# ADR-0012 — A deck has an owner

*Status: in force.*

**Decision.** Every deck carries an owner from the first one ever created, defaulting to an
explicit anonymous value rather than an absent field. Signing in is defined as *claiming*
anonymous decks, not as creating owned ones.

This was decided before any sign-in existed, deliberately.

**Rejected.** Adding ownership when sign-in ships. That leaves exactly two options at that
moment: an irreversible migration that guesses who wrote what, or a permanent class of decks
no rule covers. Writing the field from the start means the migration never has to happen.

**Consequences.**
- An absent owner is a permanent, legal value for decks that predate the field or arrived from
  outside the app. It is never backfilled — backfilling is the guess this decision exists to
  avoid.
- The identity provider interface is shaped for an asynchronous, out-of-band flow — request,
  pending, confirmation elsewhere — not a synchronous local prompt. A synchronous interface
  would have to be rebuilt rather than extended the first time a real provider arrives.
- The owner value round-trips untouched through every operation, so a downstream product can
  put structure inside it without a format change.
