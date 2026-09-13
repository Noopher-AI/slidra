// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentManager, AgentSwitchLockedError } from "../../src/agent/manager.js";
import { EditingLock } from "../../src/editing-lock.js";
import type { AgentAdapterConfig } from "../../src/agent/session.js";
import type { AgentKind } from "../../src/agent/adapters.js";
import type { CommandOutcome, CommandRunner } from "../../src/agent/probe.js";
import { readAgentSettings } from "../../src/agent/settings.js";

// Unit level (§6.2): AgentManager's own decision logic, driven purely
// through injected `runCommand`/`resolveAdapter` — no HTTP, no real
// `claude`/`codex`/adapter subprocess. `AgentChatSession` spawns lazily
// (only on the first `sendMessage`), so as long as these tests never call
// `sendMessage`, constructing/swapping/disposing sessions here never
// actually forks a process — `resolveAdapter` can return a harmless,
// never-spawned config.

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "slidra-manager-home-"));
  process.env.SLIDRA_HOME = home;
});

afterEach(async () => {
  delete process.env.SLIDRA_HOME;
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function dummyConfig(kind: AgentKind): AgentAdapterConfig {
  return { kind, label: kind === "claude" ? "Claude Code" : "Codex", command: "true", args: [] };
}

function trackingResolveAdapter(): { resolveAdapter: (kind: AgentKind) => AgentAdapterConfig; calls: AgentKind[] } {
  const calls: AgentKind[] = [];
  return {
    calls,
    resolveAdapter: (kind) => {
      calls.push(kind);
      return dummyConfig(kind);
    },
  };
}

function runCommandReturning(outcome: CommandOutcome, delayMs = 0): { runCommand: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runCommand: async (command) => {
      calls.push(command);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return outcome;
    },
  };
}

const loggedInOutcome: CommandOutcome = { code: 0, stdout: '{"loggedIn":true}', stderr: "" };
const loggedOutOutcome: CommandOutcome = { code: 0, stdout: '{"loggedIn":false}', stderr: "" };

describe("AgentManager", () => {
  it("initial.kind === null: current is null, source is none, and no session is ever built", async () => {
    const { resolveAdapter, calls } = trackingResolveAdapter();
    const { runCommand } = runCommandReturning(loggedInOutcome);
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: null, source: "none" },
      runCommand,
      resolveAdapter,
    });

    expect(calls).toEqual([]);
    const status = await manager.status();
    expect(status.current).toBeNull();
    expect(status.source).toBe("none");
    expect(calls).toEqual([]);
  });

  it("initial.source is queryable as 'cli' when serve started with --agent", async () => {
    const { resolveAdapter } = trackingResolveAdapter();
    const { runCommand } = runCommandReturning(loggedInOutcome);
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
    });

    const status = await manager.status();
    expect(status.current).toBe("claude");
    expect(status.source).toBe("cli");
  });

  it("status() probes once on first call, then reads the cache only on later calls", async () => {
    const { resolveAdapter } = trackingResolveAdapter();
    const { runCommand, calls } = runCommandReturning(loggedInOutcome);
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
    });

    await manager.status();
    expect(calls).toHaveLength(2); // one probe per adapter kind
    await manager.status();
    await manager.status();
    expect(calls).toHaveLength(2); // never reprobes on its own
  });

  it("probe() always reruns both probes, in parallel (bounded by one probe's own delay, not the sum)", async () => {
    const { resolveAdapter } = trackingResolveAdapter();
    const delayMs = 60;
    const { runCommand, calls } = runCommandReturning(loggedInOutcome, delayMs);
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
    });

    await manager.status();
    expect(calls).toHaveLength(2);
    const start = Date.now();
    await manager.probe();
    const elapsed = Date.now() - start;
    expect(calls).toHaveLength(4);
    // Sequential would be >= 2*delayMs; parallel stays close to one delay.
    expect(elapsed).toBeLessThan(delayMs * 2);
  });

  it("select() while the agent holds the editing floor throws AgentSwitchLockedError; settings unwritten, session unswapped, no event", async () => {
    const { resolveAdapter, calls } = trackingResolveAdapter();
    const { runCommand } = runCommandReturning(loggedInOutcome);
    const editingLock = new EditingLock();
    await editingLock.acquireAgent();
    let changedEvents = 0;
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock,
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
      onAgentChanged: () => {
        changedEvents++;
      },
    });
    const callsBefore = calls.length;

    await expect(manager.select("codex")).rejects.toThrow(AgentSwitchLockedError);

    expect(calls).toHaveLength(callsBefore); // no new session built
    expect(changedEvents).toBe(0);
    expect(await readAgentSettings()).toEqual({ agent: null, models: {} }); // never written
    expect((await manager.status()).current).toBe("claude"); // unchanged
  });

  it("select() with the kind already current: settings written, source becomes 'settings', but no session swap and no event", async () => {
    const { resolveAdapter, calls } = trackingResolveAdapter();
    const { runCommand } = runCommandReturning(loggedInOutcome);
    let changedEvents = 0;
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
      onAgentChanged: () => {
        changedEvents++;
      },
    });
    const callsBeforeSelect = calls.length;

    const status = await manager.select("claude");

    expect(status.current).toBe("claude");
    expect(status.source).toBe("settings");
    expect(calls).toHaveLength(callsBeforeSelect); // no new session built
    expect(changedEvents).toBe(0);
    expect(await readAgentSettings()).toEqual({ agent: "claude", models: {} });
  });

  it("select() with a different kind: builds a new session via resolveAdapter, updates source, fires onAgentChanged — even when the target is not logged in", async () => {
    const { resolveAdapter, calls } = trackingResolveAdapter();
    // The target (codex) reports logged out — select must still succeed (§7.5).
    const runCommand: CommandRunner = async (command) =>
      command === "codex" ? loggedOutOutcome : loggedInOutcome;
    let changed: { kind: AgentKind; label: string } | undefined;
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
      onAgentChanged: (payload) => {
        changed = payload;
      },
    });

    const status = await manager.select("codex");

    expect(status.current).toBe("codex");
    expect(status.source).toBe("settings");
    expect(calls).toEqual(["claude", "codex"]); // initial session, then the swap
    expect(changed).toEqual({ kind: "codex", label: "Codex" });
    expect(await readAgentSettings()).toEqual({ agent: "codex", models: {} });
  });

  it("select() propagates a settings-write failure and leaves the session unswapped", async () => {
    // Point SLIDRA_HOME at a regular file so writeAgentSelection's mkdir fails.
    await rm(home, { recursive: true, force: true });
    await writeFile(home, "not a directory");
    const { resolveAdapter, calls } = trackingResolveAdapter();
    const { runCommand } = runCommandReturning(loggedInOutcome);
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
    });
    const callsBefore = calls.length;

    await expect(manager.select("codex")).rejects.toThrow();

    expect(calls).toHaveLength(callsBefore); // no new session built
    expect((await manager.status()).current).toBe("claude"); // unchanged
  });

  it("sendMessage while current is null throws", () => {
    const { resolveAdapter } = trackingResolveAdapter();
    const { runCommand } = runCommandReturning(loggedInOutcome);
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: null, source: "none" },
      runCommand,
      resolveAdapter,
    });

    expect(() => manager.sendMessage("hi")).toThrow();
  });

  it("dispose() is idempotent — a second call is a no-op", async () => {
    const { resolveAdapter } = trackingResolveAdapter();
    const { runCommand } = runCommandReturning(loggedInOutcome);
    const manager = new AgentManager({
      presentationId: "p1",
      editingLock: new EditingLock(),
      initial: { kind: "claude", source: "cli" },
      runCommand,
      resolveAdapter,
    });

    await manager.dispose();
    await expect(manager.dispose()).resolves.toBeUndefined();
  });
});
