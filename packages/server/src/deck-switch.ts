// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * The deck-scoped state machine `serve.ts` binds its own resources
 * (`changes.ts`'s watcher, `agent/manager.ts`'s session) to (NOOP-419
 * [E6.T3]). Deliberately free of any `http`/`agent`/`watch` import — every
 * effect of a switch (retargeting the watcher, rebuilding the agent
 * session) is injected in through `bind`/`unbind`, so this module only
 * ever holds the *identity* of the currently bound deck and the ordering
 * that gets it there.
 */

/** The public identity of a deck, as far as this state machine and its listeners are concerned. `sourcePath` is a real filesystem path (ADR-0004) — callers must never put it on the wire (`serve.ts` strips it down to `fileName`). */
export interface DeckIdentity {
  id: string;
  name: string | null;
  sourcePath: string | null;
}

/** Fired once per switch, after the outgoing deck's resources have been unbound and before the incoming one is bound — never for entering from "no deck", never for a same-id switch. */
export type DeckSwitchListener = (outgoing: DeckIdentity) => void | Promise<void>;

/** Thrown by `switchTo` when a switch cannot start right now — never for an unknown id (that is the injected `resolveDeck`'s own rejection, surfaced unwrapped). */
export class DeckSwitchConflictError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "DeckSwitchConflictError";
    this.reason = reason;
  }
}

export interface DeckSession {
  /** The deck currently bound, or null when none is. */
  current(): DeckIdentity | null;
  /** `current()?.id`, null-safe — the common case every route guard needs. */
  currentId(): string | null;
  /** True for the whole unbind→hook→bind window of an in-flight switch. */
  isSwitching(): boolean;
  /** Registers a listener; returns a function that detaches it. */
  onDeckSwitch(listener: DeckSwitchListener): () => void;
  /**
   * Switches to `id`. Resolves to `{ deck, switched: false }` without
   * touching anything when `id` is already current. A conflict (another
   * switch in flight, the editing floor held, an export running) throws
   * `DeckSwitchConflictError`; an unknown id throws whatever `resolveDeck`
   * itself throws (a `SlidraNotFoundError`, unresolved).
   */
  switchTo(id: string): Promise<{ deck: DeckIdentity; switched: boolean }>;
  /**
   * Re-resolves the currently-bound deck's own identity (`resolveDeck`,
   * unchanged) and updates `current()` to match — for a change that leaves
   * *which* deck is bound untouched but changes that deck's own `name`/
   * `sourcePath`, such as the title bar's rename. Never touches any bound
   * resource (the watcher, the agent session) — callers that need those
   * re-pointed too (the rename route retargets the watcher itself) do so
   * separately. Throws if no deck is currently bound.
   */
  refreshCurrent(): Promise<DeckIdentity>;
}

export interface DeckSessionOptions {
  /** The deck `serve` already started bound to, if any — the startup path never calls `bind` (serve.ts's own `startServe` does that setup itself; see its docstring). */
  initial: DeckIdentity | null;
  /** Resolves `id` to its identity, throwing (typically `SlidraNotFoundError`) when it does not exist. Never mutates any bound resource. */
  resolveDeck(id: string): Promise<DeckIdentity>;
  /** Tears down every resource bound to `outgoing` (watcher, agent session). Never touches `outgoing`'s own files. */
  unbind(outgoing: DeckIdentity): Promise<void>;
  /** Binds every resource to `incoming` (work directory deploy, agent session, watcher). */
  bind(incoming: DeckIdentity): Promise<void>;
  /** Returns a conflict reason/message pair when a switch may not start right now (editing floor held, export running), or null when clear. */
  guard(): { reason: string; message: string } | null;
}

/**
 * Builds a `DeckSession`. The switch order below is fixed (NOOP-433 §3):
 * guard → same-id short-circuit → resolve the incoming id → unbind the
 * outgoing deck → fire the hook exactly once, with the outgoing identity →
 * bind the incoming deck. A `resolveDeck` failure leaves the outgoing deck
 * fully bound and untouched — nothing has unbound yet at that point. A
 * `bind` failure (after `unbind` already ran) leaves this session in the
 * legitimate "no deck" state rather than reverting to the outgoing deck,
 * whose resources have already been torn down.
 */
export function createDeckSession(options: DeckSessionOptions): DeckSession {
  let current = options.initial;
  let switching = false;
  const listeners = new Set<DeckSwitchListener>();

  return {
    current: () => current,
    currentId: () => current?.id ?? null,
    isSwitching: () => switching,

    onDeckSwitch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async switchTo(id) {
      if (switching) {
        throw new DeckSwitchConflictError("switching", "Another deck switch is already in progress.");
      }
      const conflict = options.guard();
      if (conflict) {
        throw new DeckSwitchConflictError(conflict.reason, conflict.message);
      }
      if (current !== null && current.id === id) {
        return { deck: current, switched: false };
      }

      // Set synchronously, before the first `await` — everything above this
      // line is synchronous (guard() and the same-id check never yield), so
      // a concurrent switchTo() call structurally cannot observe `switching
      // === false` and slip past the check at the top of this function
      // while this call is in flight; it can only run after this one has
      // already reached an await point with `switching` already true.
      switching = true;
      try {
        const incoming = await options.resolveDeck(id);
        const outgoing = current;
        if (outgoing !== null) {
          await options.unbind(outgoing);
          // Reflects the actual state the moment unbind() completes: if
          // bind() below fails, this session must report "no deck", never
          // fall back to a deck whose resources were just torn down.
          current = null;
          for (const listener of listeners) {
            try {
              await listener(outgoing);
            } catch (error) {
              // A listener is a notification, never a veto (NOOP-433 §4's
              // table) — its failure must not stop the switch or repeat the
              // call.
              console.error(error instanceof Error ? error.message : String(error));
            }
          }
        }
        await options.bind(incoming);
        current = incoming;
        return { deck: incoming, switched: true };
      } finally {
        switching = false;
      }
    },

    async refreshCurrent() {
      if (current === null) {
        throw new Error("refreshCurrent() called with no deck bound");
      }
      current = await options.resolveDeck(current.id);
      return current;
    },
  };
}
