# ADR-0013 — An extracted module takes a named dependency object

*Status: in force.*

The canvas entry grew to roughly 4,700 lines, most of them inside one closure holding 42
mutable bindings and 116 functions. Every feature touching the stage landed there, because that
closure was the only place the shared state could be reached from. Splitting it forces one
question before any code moves: how does an extracted piece reach the state it needs?

**Decision.** Each extracted domain is a factory taking one explicitly typed dependency
interface, which names every state holder and every callback that domain reads or writes, and
returning the handlers the entry wires up. The entry constructs that object and remains the only
place that knows the wiring. **The interface is capped at fourteen fields**, counted
mechanically.

**Rejected.**

- **One shared internals object** handed to every extracted module. Cheapest to write, and it
  reproduces the problem at one remove: with everything in scope a module can reach anything, so
  a reviewer is back to asking which of the 42 bindings a change could have disturbed. The only
  thing that changed is which file the question gets asked in. Size was the symptom; unbounded
  reach over shared mutable state was the disease.
- **Module-level state**, each module owning its slice. Cleanest-looking, with no plumbing at
  all. Rejected on a fact rather than a preference: the entry is mounted more than once per
  process — the test suite mounts it over ninety times, including twice into the same container.

Without a number, "narrow" is a wish. Every dependency is individually defensible, and an
uncapped interface widens one justified field at a time until it is the closure again.

**Consequences.**

- Verbosity is the price, and it is the whole price. Each domain carries an interface
  declaration that must be kept in step with what the module uses. That declaration is exactly
  what a reviewer reads instead of the closure — it is the product, not overhead.
- A domain that cannot be expressed in fourteen fields is not ready to be extracted. Leaving it
  in the entry and publishing the number is a legitimate outcome, not a failure.
- Grouping loose bindings into records is a precondition, not a nicety: 42 of them cannot be
  listed in fourteen fields.
- **This bounds reach, not mutation.** A module handed a record can still write through it.
  Making the records immutable would change behaviour and is a separate decision with its own
  costs.
- Circularity is broken by callbacks, not imports. No extracted module imports another; the
  wiring stays in one readable place.
- The dependency interface is the unit of review for this code from now on. Widening it is the
  reviewable event: a change that adds a field is making an architectural claim and should say
  why.
- Scope is the canvas. Whether it generalises to the rest of the product is left to whoever
  measures it — ADR-0008's precedent applies: measure first, then decide.
