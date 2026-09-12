// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

/**
 * Single-editor lock for T5 (NOOP-93/#110): at any moment, at most one of
 * "a human is mid-drag" or "the agent is running a turn" may hold the
 * floor. Conflicts are not mitigated — they are made unrepresentable.
 *
 * Three states:
 *   - `idle`   — nobody is editing.
 *   - `human`  — a human editing gesture (e.g. a drag) is in progress.
 *   - `agent`  — the agent's current turn is running commands.
 *
 * This is in-memory, scoped to one `slidra serve` process (one
 * presentation per process today — see AgentAdapterConfig's own docs) —
 * never written to disk, never a cross-process lockfile. A restart starts
 * from `idle`, which is correct: nothing was actually in flight across a
 * restart.
 */
export type EditingLockState = "idle" | "human" | "agent";

/**
 * Upper bound on how long a human editing lease (`beginHumanEdit`) may run
 * without being renewed. Not a UX timeout — it exists purely so a browser
 * tab closed mid-drag (no `endHumanEdit` ever arrives) cannot wedge the
 * agent out forever. T2 (NOOP-91)'s real drag UI is expected to renew this
 * lease periodically for drags that run longer than this.
 */
export const HUMAN_LEASE_MAX_MS = 5000;

/** Thrown by `beginHumanEdit` when the agent currently holds the floor. */
export class EditingLockConflictError extends Error {
  constructor() {
    super("The agent is currently editing, please wait.");
  }
}

interface EditingLockEvents {
  frozen: () => void;
  unfrozen: () => void;
}

/**
 * `acquireAgent`/`releaseAgent` are the agent-turn side (wired from
 * `AgentChatSession`); `beginHumanEdit`/`endHumanEdit` are the human side
 * (wired from the HTTP routes). `frozen`/`unfrozen` fire exactly once per
 * agent turn that actually acquires the lock — never for a turn that never
 * ran a command, and never twice for the same turn's later commands.
 */
export class EditingLock extends EventEmitter {
  private state: EditingLockState = "idle";
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters: Array<() => void> = [];

  override on<K extends keyof EditingLockEvents>(event: K, listener: EditingLockEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  getState(): EditingLockState {
    return this.state;
  }

  /**
   * Starts (or, called again while already `human`, renews) a human editing
   * lease. Throws `EditingLockConflictError` while the agent holds the
   * floor — the HTTP route turns that into a 409, never a queue.
   */
  beginHumanEdit(): void {
    if (this.state === "agent") {
      throw new EditingLockConflictError();
    }
    this.state = "human";
    this.armLease();
  }

  /** Ends the human lease. A no-op (not an error) when no lease is open — an extra `end` is not a mistake. */
  endHumanEdit(): void {
    if (this.state !== "human") return;
    this.disarmLease();
    this.state = "idle";
    this.releaseWaiters();
  }

  /**
   * Waits for any in-progress human lease to end (or expire), then takes
   * the agent lock. Idempotent for the *same* turn: a second, third, ...
   * command in one turn that is already holding the lock resolves
   * immediately without re-emitting `frozen`. Never throws and never
   * refuses — this is the "agent waits, never throws" contract.
   */
  async acquireAgent(): Promise<void> {
    while (this.state === "human") {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.state === "agent") return;
    this.state = "agent";
    this.emit("frozen");
  }

  /** Releases the agent lock taken by `acquireAgent`. A no-op when the agent does not currently hold it. */
  releaseAgent(): void {
    if (this.state !== "agent") return;
    this.state = "idle";
    this.emit("unfrozen");
    this.releaseWaiters();
  }

  private armLease(): void {
    this.disarmLease();
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined;
      this.state = "idle";
      this.releaseWaiters();
    }, HUMAN_LEASE_MAX_MS);
    // Never keep the process alive on this alone — a test or a short-lived
    // `slidra serve` shutting down must not wait out this timer.
    this.leaseTimer.unref?.();
  }

  private disarmLease(): void {
    if (this.leaseTimer !== undefined) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = undefined;
    }
  }

  private releaseWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
