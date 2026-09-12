import { describe, expect, it } from "vitest";
import { probeLogin, type CommandOutcome, type CommandRunner } from "../../src/agent/probe.js";

// Pure decision logic driven entirely through an injected CommandRunner —
// no real `claude`/`codex` CLI is ever spawned here: the "happy path,
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

  it("passes the centralized probeCommand from adapters.ts to the runner (claude)", async () => {
    let seen: { command: string; args: string[] } | undefined;
    const runner: CommandRunner = async (command, args) => {
      seen = { command, args };
      return outcome({ stdout: '{"loggedIn":false}' });
    };
    await probeLogin("claude", runner);
    expect(seen).toEqual({ command: "claude", args: ["auth", "status", "--json"] });
  });

  it("passes the centralized probeCommand from adapters.ts to the runner (codex)", async () => {
    let seen: { command: string; args: string[] } | undefined;
    const runner: CommandRunner = async (command, args) => {
      seen = { command, args };
      return outcome({ code: 0 });
    };
    await probeLogin("codex", runner);
    expect(seen).toEqual({ command: "codex", args: ["login", "status"] });
  });
});
