// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, describe, expect, it } from "vitest";
import { probeLogin, withAcpHandshakeTimeout, type CommandOutcome, type CommandRunner } from "../../src/agent/probe.js";

// Pure decision logic driven entirely through an injected CommandRunner —
// no real agent login command is ever spawned here: the "happy path,
// actually logged in" case can only be verified this way since the suite
// must pass on a machine that is not logged into either.

function outcome(partial: Partial<CommandOutcome>): CommandOutcome {
  return { code: 0, stdout: "", stderr: "", ...partial };
}

function runnerReturning(result: CommandOutcome): CommandRunner {
  return async () => result;
}

describe("probeLogin", () => {
  it("claude: code 0 with loggedIn:true reports logged in, no detail", async () => {
    const result = await probeLogin("claude", runnerReturning(outcome({ stdout: '{"loggedIn":true}' })));
    expect(result).toEqual({ loggedIn: true });
  });

  it("claude: code 0 with loggedIn:false is the ordinary logged-out state — no detail", async () => {
    const result = await probeLogin(
      "claude",
      runnerReturning(outcome({ stdout: '{"loggedIn":false,"authMethod":"none"}' })),
    );
    expect(result).toEqual({ loggedIn: false });
  });

  it("claude: code 0 with unparseable stdout reports not logged in, with detail", async () => {
    const result = await probeLogin("claude", runnerReturning(outcome({ stdout: "not json" })));
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toBeDefined();
  });

  it("claude: code 0 but JSON has no loggedIn field reports not logged in, with detail", async () => {
    const result = await probeLogin("claude", runnerReturning(outcome({ stdout: '{"authMethod":"none"}' })));
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toBeDefined();
  });

  it("claude: non-zero exit code reports not logged in, with detail including the exit code", async () => {
    const result = await probeLogin(
      "claude",
      runnerReturning(outcome({ code: 1, stderr: "boom" })),
    );
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("1");
    expect(result.detail).toContain("boom");
  });

  it("codex: code 0 reports logged in", async () => {
    const result = await probeLogin("codex", runnerReturning(outcome({ code: 0 })));
    expect(result).toEqual({ loggedIn: true });
  });

  it("codex: non-zero exit code (e.g. real-world 1, 'Not logged in') is the ordinary logged-out state — no detail", async () => {
    const result = await probeLogin("codex", runnerReturning(outcome({ code: 1, stdout: "Not logged in" })));
    expect(result).toEqual({ loggedIn: false });
  });

  it("pi: the local Qwen endpoint probe uses exit status", async () => {
    expect(await probeLogin("pi", runnerReturning(outcome({ code: 0 })))).toEqual({ loggedIn: true });
    expect(await probeLogin("pi", runnerReturning(outcome({ code: 1 })))).toEqual({ loggedIn: false });
  });

  it("either agent: spawn failure/timeout (code: null) is treated as not logged in, with a reason", async () => {
    const result = await probeLogin(
      "claude",
      runnerReturning({ code: null, stdout: "", stderr: "ENOENT" }),
    );
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("ENOENT");
  });

  it("codex: spawn failure/timeout (code: null) is also treated as not logged in, with a reason", async () => {
    const result = await probeLogin("codex", runnerReturning({ code: null, stdout: "", stderr: "timed out" }));
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toContain("timed out");
  });

  it("truncates a very long detail to 200 chars, noting the truncation", async () => {
    const longStdout = "x".repeat(5000);
    const result = await probeLogin("claude", runnerReturning(outcome({ stdout: longStdout })));
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toBeDefined();
    expect(result.detail!.length).toBeLessThan(300);
    expect(result.detail).toMatch(/truncated/);
  });

  // Was three near-identical tests (one per bundled kind, claude/codex/pi),
  // each asserting the same thing — probeLogin forwards adapters.ts's own
  // `probeCommand` verbatim, never a hardcoded string of its own — with a
  // different fixture. Merged into one table-driven test (E10.T6/#400 test
  // budget §6): same coverage, one assertion path instead of three copies.
  it.each([
    ["claude", { stdout: '{"loggedIn":false}' }, { command: "claude", args: ["auth", "status", "--json"] }],
    ["codex", { code: 0 }, { command: "codex", args: ["login", "status"] }],
  ] as const)("forwards %s's own probeCommand verbatim to the runner, never a string of its own", async (kind, response, expected) => {
    let seen: { command: string; args: string[] } | undefined;
    const runner: CommandRunner = async (command, args) => {
      seen = { command, args };
      return outcome(response);
    };
    await probeLogin(kind, runner);
    expect(seen).toEqual(expected);
  });

  it("pi's probeCommand is the local OpenAI-compatible endpoint probe, not a plain executable name", async () => {
    let seen: { command: string; args: string[] } | undefined;
    const runner: CommandRunner = async (command, args) => {
      seen = { command, args };
      return outcome({ code: 0 });
    };
    await probeLogin("pi", runner);
    expect(seen?.command).toBe(process.execPath);
    expect(seen?.args.join(" ")).toContain("SLIDRA_PI_BASE_URL");
    expect(seen?.args.join(" ")).toContain("/models");
    expect(seen?.args.join(" ")).not.toContain(process.env.SLIDRA_PI_API_KEY ?? "not-present");
  });
});

// E10.T6/#400 D3/AC3: a declared adapter that starts but never speaks ACP
// must fail with a named reason within a bounded time, never hang forever.
describe("withAcpHandshakeTimeout", () => {
  afterEach(() => {
    delete process.env.SLIDRA_ACP_HANDSHAKE_TIMEOUT_MS;
  });

  it("resolves with the underlying work's value when it settles before the timeout", async () => {
    await expect(withAcpHandshakeTimeout("My Agent", Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("rejects the underlying work's own error when it rejects before the timeout", async () => {
    await expect(withAcpHandshakeTimeout("My Agent", Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });

  it("a work that never settles rejects within the given bound, naming the label and the millisecond bound", async () => {
    const neverSettles = new Promise<void>(() => {});
    await expect(withAcpHandshakeTimeout("My Agent", neverSettles, 20)).rejects.toThrow(/My Agent.*20ms/);
  });

  it("reads SLIDRA_ACP_HANDSHAKE_TIMEOUT_MS as its default bound when no explicit timeoutMs is given", async () => {
    process.env.SLIDRA_ACP_HANDSHAKE_TIMEOUT_MS = "20";
    const neverSettles = new Promise<void>(() => {});
    await expect(withAcpHandshakeTimeout("My Agent", neverSettles)).rejects.toThrow(/20ms/);
  });
});
