# One server, one current deck, switchable

A `slidra serve` process used to require a `presentationId` at startup, and never changed it for the life of the process — one server, one deck, fixed at launch. [E6.T3] removes that constraint without moving to "one server, many decks at once": there is still exactly one deck bound at any moment, but which deck that is becomes state the server owns and can change, and "no deck bound" becomes a legitimate state in its own right rather than an error condition to route around.

## Decision

**`presentationId` moves from a start-up argument to server-owned state** (`DeckSession`, `deck-switch.ts`), with `POST /api/deck/switch` as the only way to change it after boot. `serve` always starts, with or without an initial deck; the startup path itself never goes through `DeckSession`'s own `bind` (kept as the pre-existing direct setup, deliberately, to keep that diff small) — `bind`/`unbind` exist for what happens *after* boot.

**"No deck open" is a first-class, fully supported state, not a transient one.** Every deck-scoped route responds `409 { reason: "no-deck" }` rather than crashing or 404ing; an SSE stream opens with nothing watching rather than refusing the connection; an agent kind can be selected with no deck open, and building a session for it is simply deferred (`maybeBuildSession` never runs one with a null presentation id).

**A switch is a fixed, non-negotiable order**, never partially reversible: guard → same-id short-circuit → resolve the incoming id → unbind the outgoing deck → notify listeners once, with the outgoing identity → bind the incoming deck. Two failure points are handled asymmetrically, on purpose: a `resolveDeck` failure (unknown id) leaves the outgoing deck fully bound and untouched, since nothing has unbound yet; a `bind` failure *after* `unbind` already ran leaves the session in the legitimate "no deck" state rather than reverting to the outgoing deck, whose resources (watcher, agent session) have already been torn down and cannot be un-torn-down.

## The confirm-cancel-wait sequence while the agent is working, and why a hard switch is refused outright

An agent turn in progress holds what the codebase calls the **editing floor** (`AgentSwitchLockedError`) — a lock scoped to the currently-bound deck's session. `DeckSession.switchTo`'s `guard()` refuses to even begin a switch while that floor is held (`409 { reason: "editing" }`) or while an export is running (`409 { reason: "exporting" }`); the caller's only path to a switch is to wait for the turn to finish, or call the existing `cancel()` (which stops the current turn plus every message queued behind it) first. There is no "hard switch" path in this codebase that skips the guard — this ADR records **why that door stays closed**, not a feature that exists.

A switch that skipped the guard and forced a rebind mid-turn would leave at least three things inconsistent, each traceable to a concrete piece of per-deck state this codebase already treats as scoped to one bound deck at a time:

1. **The agent session itself** (`agent/manager.ts`) is built against one `presentationId`/`workdir` pair; a command the agent already issued, or is mid-stream on, would keep running against a workdir whose deck has just been unbound underneath it.
2. **Persisted chat history** (`ChatLog`, [E6.T7]) is deck-scoped and written incrementally as a turn progresses; retargeting it mid-turn, rather than after the turn has actually stopped, risks an entry being flushed against the wrong deck's `chat_history` table, or never being finalized at all.
3. **The undo/redo history group** a command opens on the outgoing deck (`docs/spec/slidra-format.md` §1.4) has no defined outcome for "abandoned because the deck was swapped out from under it mid-group" — every existing consumer of history groups assumes the deck they were opened on is still the bound one until the group closes.

The actual switch path avoids exactly these three by construction, not by explicit conflict detection: `retarget()` (`agent/manager.ts`) always disposes the previous session and marks any unfinished chat entry interrupted (`markUnfinishedInterrupted`) *before* flushing and re-pointing the chat log at the incoming deck, and this only ever runs once `unbind` has completed — which the guard above ensures never happens while a turn holds the editing floor in the first place. The ordering in `deck-switch.ts` and the refusal in `guard()` are two halves of the same decision: refuse the switch that would need reconciling, rather than build the reconciliation.

## Considered Options

- **Request-scoped deck ids** (each HTTP request or SSE connection names which deck it means, rather than all of them implicitly meaning "whichever deck is currently bound"): deferred, not rejected outright — see "Why request-scoped deck ids were deferred" below.
- **Allow a switch to preempt an in-flight agent turn** (cancel it automatically, then proceed): rejected — an automatic cancel the author didn't ask for is a worse experience than a 409 telling them to wait or cancel explicitly, and it reintroduces exactly the reconciliation problem ("what happens to the turn's chat entry, its undo group") the refusal below exists to avoid.
- **Queue the switch and apply it once the turn finishes**, rather than refusing it outright: rejected for this ADR's scope — it requires the caller (the UI) to track a pending switch across an unknown wait, which is a UI-state problem this server-side ADR does not need to solve to make "no hard switch" hold; refuse-and-let-the-caller-retry keeps the server's own state machine simple.

### Why request-scoped deck ids were deferred

A request-scoped id would remove the single-current-deck constraint entirely and let one server hold several decks open in parallel. That is out of scope here: it needs per-request routing through every deck-scoped module (`agent/manager.ts`, `changes.ts`, `save-state.ts`, `command-endpoint.ts`), each of which is currently written, deliberately, against "the one bound deck." This is the shape the cloud edition (multi-tenant, one server instance potentially serving several authors' decks at once) will need; the local single-user product this ADR describes does not, and building it speculatively now would be exactly the premature abstraction this project's own conventions warn against.

## Consequences

- Every deck-scoped route must check `currentId() === null` first and return `409 { reason: "no-deck" }` before any other guard — the no-deck case is checked ahead of the existing per-route checks, not folded into them.
- `DeckIdentity` sent over the wire never includes `sourcePath` itself (ADR-0004) — only its basename — since the wire format is shared with the switch response and the initial-load payload alike.
- A switch listener (`onDeckSwitch`) is a notification, never a veto: a listener that throws only logs the error and does not stop or repeat the switch, keeping "who is subscribed" from being able to block "what the current deck is."
