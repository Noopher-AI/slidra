# An extracted module receives a named dependency object, never a shared internals bag

`packages/web/src/canvas.ts` grew to 4,770 lines, 3,306 of them inside `mountCanvas`, a single
closure holding 42 mutable bindings and 116 functions. Every feature touching the stage lands there,
because that closure is the only place the shared state is reachable from. Splitting it (#379) forces
one decision before any code moves: **how does an extracted piece reach the state it needs?**

Decision: **each extracted domain is a factory function taking one explicitly typed dependency
interface** — `GestureDeps`, `RuntimeMessageDeps`, `PlayModeDeps` — that names every state holder and
every callback the domain reads or writes, and returning the handlers the closure wires up. The
closure constructs the object and remains the only place that knows the wiring.

**The interface is capped at 14 fields.** Without a number, "narrow" is a wish; every dependency is
individually defensible, and an uncapped interface widens one justified field at a time until it is
the closure again.

## Considered Options

- **One shared `internals` object** holding all the closure state, handed to every extracted module.
  Cheapest to write: one object, no per-domain interface to maintain, no churn when a domain starts
  needing one more thing. Rejected because it reproduces the problem at one remove. With `internals`
  in scope a module can reach anything, so a reviewer is back to asking "which of the 42 could this
  have disturbed" — the only thing that changed is which file the question gets asked in. The
  4,770-line file is not the disease; unbounded reach over shared mutable state is, and the file size
  is a symptom of it. Splitting the symptom and keeping the disease costs the whole refactor and buys
  a directory listing.
- **Module-level state**: each module owns its slice as module-level `let` bindings. Cleanest-looking
  option, and no dependency plumbing at all. Rejected on a fact, not a preference: `mountCanvas` is
  called more than once per process. The test suite mounts it over ninety times, and
  `packages/web/test/canvas.test.ts:110` mounts twice into the same container to assert the second
  mount replaces the first. Module-level state would be shared across those mounts. That is a
  behaviour change, and this work permits none.
- **Individual parameters** instead of one object. Rejected on measurement: gestures need thirteen,
  play mode about ten after state grouping. A thirteen-parameter call site is less readable than a
  thirteen-field object, and adding a dependency churns every call site instead of one declaration.

## Consequences

- **Verbosity is the price, and it is the whole price.** Each domain carries an interface declaration
  that has to be kept in step with what the module actually uses. That declaration is exactly what a
  reviewer reads instead of the closure; it is the product, not overhead.
- **The cap is enforced, not aspirational.** At most fourteen fields per dependency interface,
  counted mechanically as part of #379's acceptance. A domain that cannot be expressed in fourteen
  fields is not ready to be extracted, and the honest response is to leave it in the closure and
  publish the number — this is what #379's escape hatch for play mode is, and it is a legitimate
  outcome rather than a failure.
- **Grouping the state into records is a precondition, not a nicety.** Forty-two loose bindings
  cannot be listed in fourteen fields. Records (selection, overlay, frame, table range, chart window,
  embeds, listeners) are what makes the cap reachable at all, which is why #379 sequences them before
  any extraction.
- **This bounds reach, not mutation.** A module handed the `frame` record can still write
  `frame.viewport`. Making the records immutable would change behaviour and is out of scope here; if
  it is ever wanted, it is a separate decision with its own costs.
- **Circularity is broken by callbacks, not imports.** Runtime message handling dispatches to gesture
  handlers, and gestures notify through the closure. Those arrive as function fields on the
  dependency object, supplied by the closure — so no extracted module imports another, and the
  wiring stays in one readable place.
- **The dependency interface is the unit of review for this code from now on.** A change inside an
  extracted module can only reach what its interface exposes, so widening the interface is the
  reviewable event. A pull request that adds a field is making an architectural claim and should say
  why.
- **Scope is the canvas.** This is established here, for `packages/web/src/canvas/`. Whether it
  generalises to the React app shell, the server entry, or the Rust element editing module is left to
  whoever measures those — ADR-0012's precedent applies: measure first, then decide.
