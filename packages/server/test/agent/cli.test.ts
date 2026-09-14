// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runServeCli } from "../../src/cli.js";
import { agentSettingsPath } from "../../src/agent/settings.js";

const execFileAsync = promisify(execFile);
const slidraBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../target/release/slidra");

interface CliEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
  failureKind?: string;
}

async function runCli<T = unknown>(args: string[]): Promise<CliEnvelope<T>> {
  try {
    const { stdout } = await execFileAsync(slidraBinPath, [...args, "--json"], { env: process.env });
    return JSON.parse(stdout.trim()) as CliEnvelope<T>;
  } catch (error) {
    const err = error as { stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
      return JSON.parse(err.stdout.trim()) as CliEnvelope<T>;
    }
    throw error;
  }
}

// serve must always start, whether or not an agent is selected — "no agent"
// (or "selected but not logged in") is a supported state, never a startup
// failure (inverting the old detect/select-driven exit(1) this file used to
// guard). Driven through the real `runServeCli` entry point — `cli.ts`
// exposes no injection seam for `AgentManager`'s `CommandRunner` (that seam
// is `serve.ts`'s `ServeOptions.agentManager`, test-only and never reached
// from `runServeCli`) — this file puts fake `claude`/`codex` executables
// ahead of the real ones on `PATH` instead (see `beforeEach` below), so
// every test here reports "not logged in" deterministically, regardless of
// whether this pod's real CLIs happen to be logged in. `AgentAvailability`
// collapses "not installed" and "not logged in" into the same
// `unauthenticated` state (decision §7.3), so this is a faithful exercise of
// the same path a real not-logged-in CLI would take.
//
// `runServeCli` blocks until SIGINT/SIGTERM (real CLI usage) — tests start
// it, wait for its one "started" console.log line, then synthesize SIGINT via
// `process.emit` (fires the listener without invoking the OS default/
// killing this test process) to let it shut down cleanly.

const FAKE_CLAUDE_NOT_LOGGED_IN = '#!/bin/sh\necho \'{"loggedIn":false}\'\nexit 0\n';
const FAKE_CODEX_NOT_LOGGED_IN = "#!/bin/sh\necho 'Not logged in'\nexit 1\n";

let home: string;
let slidraDir: string;
let fakeCliDir: string;
let originalPath: string | undefined;

/** Writes fake `claude`/`codex` scripts, both reporting "not logged in", into a fresh temp dir. */
async function writeFakeCli(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "slidra-fake-cli-"));
  const claudePath = path.join(dir, "claude");
  const codexPath = path.join(dir, "codex");
  await writeFile(claudePath, FAKE_CLAUDE_NOT_LOGGED_IN);
  await chmod(claudePath, 0o755);
  await writeFile(codexPath, FAKE_CODEX_NOT_LOGGED_IN);
  await chmod(codexPath, 0o755);
  return dir;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "slidra-cli-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-cli-files-"));
  process.env.SLIDRA_HOME = home;
  process.env.SLIDRA_BIN = slidraBinPath;

  fakeCliDir = await writeFakeCli();
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeCliDir}${path.delimiter}${originalPath ?? ""}`;
});

afterEach(async () => {
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  process.env.PATH = originalPath;
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(fakeCliDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function openFreshPresentation(): Promise<string> {
  const slidraPath = path.join(slidraDir, "deck.slidra");
  const created = await runCli(["new", slidraPath, "--name", "Test Presentation"]);
  expect(created.ok).toBe(true);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
  return opened.data!.id;
}

interface StartedCli {
  runPromise: Promise<number>;
  logs: string[];
  url: string;
  /** Sends a synthesized SIGINT (fires the listener without invoking the OS default) and waits for clean shutdown. */
  shutdown: () => Promise<number>;
}

/** Starts `runServeCli` and waits for both its "started" line and the one agent-status line after it, before returning control to the test. */
async function startCli(argv: string[]): Promise<StartedCli> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const runPromise = runServeCli(argv);

  // The agent status line is printed right after "started" — waiting for two
  // calls means both have landed before the test does anything else.
  await vi.waitFor(
    () => {
      if (logSpy.mock.calls.length < 2) throw new Error("still waiting for both startup lines");
    },
    { timeout: 10_000, interval: 20 },
  );

  const logs = logSpy.mock.calls.map((call) => String(call[0]));
  const startedLine = logs.find((line) => line.includes("started"));
  const match = startedLine && /(http:\/\/\S+)/.exec(startedLine);
  if (!match) throw new Error(`no URL found in logs: ${JSON.stringify(logs)}`);

  return {
    runPromise,
    logs,
    url: match[1],
    shutdown: async () => {
      process.emit("SIGINT");
      const exitCode = await runPromise;
      // `runServeCli` registers a `process.once("SIGTERM", ...)` listener
      // alongside the SIGINT one (real CLI usage: either signal shuts it
      // down). Only SIGINT fires here, so that SIGTERM listener is never
      // consumed and leaks — across enough tests, some later, unrelated
      // real SIGTERM (e.g. the test runner's own worker teardown) fires
      // all of them at once, each calling an already-closed server's
      // `.close()` again (ERR_SERVER_NOT_RUNNING, as an unhandled
      // rejection). Removing it here is test-only hygiene, not a change to
      // production shutdown behaviour.
      process.removeAllListeners("SIGTERM");
      logSpy.mockRestore();
      return exitCode;
    },
  };
}

describe("runServeCli", () => {
  it("an agent selected via --agent but not logged in — serve starts, exits 0, prints exactly one (parenthesized) agent status line", async () => {
    const id = await openFreshPresentation();

    const cli = await startCli([id, "--port", "0", "--agent", "claude"]);
    try {
      expect(cli.logs[0]).toContain("Slidra started:");
      const agentLines = cli.logs.filter((line) => line.startsWith("Using agent") || line.includes("No agent selected"));
      expect(agentLines).toHaveLength(1);
      expect(agentLines[0]).toContain("Claude Code");
      expect(agentLines[0]).toContain("claude auth login");
    } finally {
      // Guarantees the server is closed (and its SIGTERM listener removed)
      // even when an assertion above throws — otherwise a failed run leaks
      // a live server into the rest of the suite.
      expect(await cli.shutdown()).toBe(0);
    }
  });

  it("no agent selected at all (no --agent, no settings.json): serve still starts, exits 0, and says so", async () => {
    const id = await openFreshPresentation();

    const cli = await startCli([id, "--port", "0"]);
    expect(cli.logs).toContain("No agent selected yet, chat is not configured; serve's other features work as usual.");

    expect(await cli.shutdown()).toBe(0);
  });

  it("--agent overrides settings.json for this run only — source is 'cli', settings.json is left untouched", async () => {
    const id = await openFreshPresentation();
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "claude" }));
    const settingsBefore = await readFile(agentSettingsPath(), "utf8");

    const cli = await startCli([id, "--port", "0", "--agent", "codex"]);
    const response = await fetch(`${cli.url}/api/agent`);
    const status = (await response.json()) as { current: string; source: string };
    expect(status.current).toBe("codex");
    expect(status.source).toBe("cli");

    const settingsAfter = await readFile(agentSettingsPath(), "utf8");
    expect(settingsAfter).toBe(settingsBefore);

    expect(await cli.shutdown()).toBe(0);
  });

  it("no --agent: settings.json's previous selection is used, source is 'settings'", async () => {
    const id = await openFreshPresentation();
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), JSON.stringify({ agent: "codex" }));

    const cli = await startCli([id, "--port", "0"]);
    const response = await fetch(`${cli.url}/api/agent`);
    const status = (await response.json()) as { current: string; source: string };
    expect(status.current).toBe("codex");
    expect(status.source).toBe("settings");

    await cli.shutdown();
  });

  it("a broken settings.json does not prevent serve from starting — logs one line and continues with no agent selected", async () => {
    const id = await openFreshPresentation();
    await mkdir(home, { recursive: true });
    await writeFile(agentSettingsPath(), "{ not json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cli = await startCli([id, "--port", "0"]);
    expect(cli.logs).toContain("No agent selected yet, chat is not configured; serve's other features work as usual.");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();

    expect(await cli.shutdown()).toBe(0);
  });

  it("still returns 1, before ever printing \"started\", for a failure unrelated to agent selection (unknown presentation id)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await runServeCli(["not-a-real-presentation-id", "--port", "0"]);

    expect(exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("no presentation-id argument at all: serve still starts, exits 0, and GET /api/deck reports no deck open (NOOP-433)", async () => {
    const cli = await startCli(["--port", "0"]);
    try {
      expect(cli.logs[0]).toContain("Slidra started:");
      const response = await fetch(`${cli.url}/api/deck`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deck: null });
    } finally {
      expect(await cli.shutdown()).toBe(0);
    }
  });
});
