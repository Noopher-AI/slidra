import { describe, expect, it, vi } from "vitest";
import { EditingLock, EditingLockConflictError, HUMAN_LEASE_MAX_MS } from "../src/editing-lock.js";

describe("EditingLock", () => {
  it("starts idle", () => {
    const lock = new EditingLock();
    expect(lock.getState()).toBe("idle");
  });

  it("acquireAgent takes the lock from idle and emits frozen once", async () => {
    const lock = new EditingLock();
    const frozen = vi.fn();
    lock.on("frozen", frozen);
    await lock.acquireAgent();
    expect(lock.getState()).toBe("agent");
    expect(frozen).toHaveBeenCalledTimes(1);
  });

  it("a second acquireAgent call in the same turn is a no-op — resolves immediately, does not re-emit frozen", async () => {
    const lock = new EditingLock();
    const frozen = vi.fn();
    lock.on("frozen", frozen);
    await lock.acquireAgent();
    await lock.acquireAgent();
    expect(frozen).toHaveBeenCalledTimes(1);
  });

  it("releaseAgent returns to idle and emits unfrozen", async () => {
    const lock = new EditingLock();
    const unfrozen = vi.fn();
    lock.on("unfrozen", unfrozen);
    await lock.acquireAgent();
    lock.releaseAgent();
    expect(lock.getState()).toBe("idle");
    expect(unfrozen).toHaveBeenCalledTimes(1);
  });

  it("releaseAgent is a no-op when the agent does not hold the lock", () => {
    const lock = new EditingLock();
    const unfrozen = vi.fn();
    lock.on("unfrozen", unfrozen);
    lock.releaseAgent();
    expect(lock.getState()).toBe("idle");
    expect(unfrozen).not.toHaveBeenCalled();
  });

  it("beginHumanEdit moves idle to human", () => {
    const lock = new EditingLock();
    lock.beginHumanEdit();
    expect(lock.getState()).toBe("human");
  });

  it("beginHumanEdit while agent holds the lock throws EditingLockConflictError", async () => {
    const lock = new EditingLock();
    await lock.acquireAgent();
    expect(() => lock.beginHumanEdit()).toThrow(EditingLockConflictError);
    expect(lock.getState()).toBe("agent");
  });

  it("beginHumanEdit called again while already human renews without error", () => {
    const lock = new EditingLock();
    lock.beginHumanEdit();
    expect(() => lock.beginHumanEdit()).not.toThrow();
    expect(lock.getState()).toBe("human");
  });

  it("endHumanEdit returns to idle", () => {
    const lock = new EditingLock();
    lock.beginHumanEdit();
    lock.endHumanEdit();
    expect(lock.getState()).toBe("idle");
  });

  it("endHumanEdit is a no-op (not an error) when no human lease is open", () => {
    const lock = new EditingLock();
    expect(() => lock.endHumanEdit()).not.toThrow();
    expect(lock.getState()).toBe("idle");
  });

  it("acquireAgent waits for an in-progress human lease to end, then takes the lock without throwing", async () => {
    const lock = new EditingLock();
    lock.beginHumanEdit();

    let acquired = false;
    const acquiring = lock.acquireAgent().then(() => {
      acquired = true;
    });

    // Give the microtask queue a turn — acquireAgent must still be waiting,
    // not resolved, while the human lease is open.
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(lock.getState()).toBe("human");

    lock.endHumanEdit();
    await acquiring;
    expect(acquired).toBe(true);
    expect(lock.getState()).toBe("agent");
  });

  it("a human lease that is never ended is auto-released after HUMAN_LEASE_MAX_MS, unblocking a waiting agent", async () => {
    vi.useFakeTimers();
    try {
      const lock = new EditingLock();
      lock.beginHumanEdit();

      let acquired = false;
      const acquiring = lock.acquireAgent().then(() => {
        acquired = true;
      });

      await vi.advanceTimersByTimeAsync(HUMAN_LEASE_MAX_MS);
      await acquiring;
      expect(acquired).toBe(true);
      expect(lock.getState()).toBe("agent");
    } finally {
      vi.useRealTimers();
    }
  });
});
