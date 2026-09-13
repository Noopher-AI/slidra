// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { spawn } from "node:child_process";
import type { AgentKind } from "./adapters.js";
import { adapterSpecFor } from "./adapters.js";

/** Upper bound on how long a login-status probe may run before it counts as a failure (NOOP-230 §4.2). */
export const PROBE_TIMEOUT_MS = 5000;

/** Longest `detail` string a probe result ever carries — see `truncateDetail` below. */
const MAX_DETAIL_CHARS = 200;
const DETAIL_TRUNCATED_SUFFIX = "… (truncated)";

export interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs one command and resolves with its outcome — never rejects. Injected
 * everywhere a probe runs so tests can script every row of the behaviour
 * table without a real `claude`/`codex` CLI on the machine running the
 * suite (the happy "logged in" path in particular can only be verified this
 * way — see the ticket's §3.3).
 */
export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandOutcome>;

/**
 * Real implementation: spawns `command`, collects stdout/stderr, and
 * resolves once the child exits or `timeoutMs` elapses. A spawn failure
 * (ENOENT, no permission, ...) and a timeout are both reported the same
 * way as a real command that never got the chance to be one:
 * `code: null` — never a rejected promise, so a caller never needs a
 * try/catch just to probe login status.
 */
export const spawnCommandRunner: CommandRunner = (command, args, timeoutMs) => {
  return new Promise<CommandOutcome>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, stdout, stderr: `Timed out (${timeoutMs}ms)` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
};

export interface ProbeResult {
  loggedIn: boolean;
  detail?: string;
}

/**
 * Probes whether `kind`'s underlying CLI is currently logged in
 * (NOOP-230 §4.2 — this is a login-status check, entirely separate from
 * whether the ACP adapter itself is spawnable). The two agents are read
 * differently on purpose, per the ticket's own already-verified research:
 *
 *   - claude: `claude auth status --json`'s `loggedIn` field. The exit code
 *     is 0 even when logged out, so it is never consulted.
 *   - codex: `codex login status`'s exit code (0 = logged in). No JSON to
 *     parse.
 *
 * `detail` is populated only when the probe itself could not positively
 * confirm the ordinary "ready to answer, and the answer is logged out"
 * case — a genuinely unparseable/unexpected response, a non-zero claude
 * exit code, or the run never completing at all (spawn failure/timeout).
 * A plain "yes I ran, and you are logged out" carries no `detail` — that is
 * the everyday not-logged-in state, not a probe failure.
 */
export async function probeLogin(kind: AgentKind, run: CommandRunner): Promise<ProbeResult> {
  const { command, args } = adapterSpecFor(kind).probeCommand;
  const outcome = await run(command, args, PROBE_TIMEOUT_MS);

  if (outcome.code === null) {
    return { loggedIn: false, detail: truncateDetail(outcome.stderr || "Failed to run the probe command") };
  }

  if (kind === "codex") {
    // Exit code is the entire signal; a non-zero exit (including the real
    // "Not logged in" case, exit 1) is the ordinary logged-out state, not a
    // probe failure worth surfacing as `detail`.
    return { loggedIn: outcome.code === 0 };
  }

  // kind === "claude"
  if (outcome.code !== 0) {
    const excerpt = outcome.stderr.trim() || outcome.stdout.trim();
    return {
      loggedIn: false,
      detail: truncateDetail(`Exit code ${outcome.code}${excerpt ? `: ${excerpt}` : ""}`),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    return { loggedIn: false, detail: truncateDetail(`Failed to parse response: ${outcome.stdout}`) };
  }
  if (typeof parsed !== "object" || parsed === null || !("loggedIn" in parsed)) {
    return { loggedIn: false, detail: truncateDetail(`Response is missing the loggedIn field: ${outcome.stdout}`) };
  }
  const loggedIn = (parsed as { loggedIn: unknown }).loggedIn;
  if (typeof loggedIn !== "boolean") {
    return { loggedIn: false, detail: truncateDetail(`loggedIn field is not a boolean: ${outcome.stdout}`) };
  }
  // loggedIn === false here is the ordinary logged-out state — no detail.
  return { loggedIn };
}

function truncateDetail(text: string): string {
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return text.slice(0, MAX_DETAIL_CHARS) + DETAIL_TRUNCATED_SUFFIX;
}
