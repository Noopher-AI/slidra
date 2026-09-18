// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { spawn } from "node:child_process";
import { ADAPTER_SPECS, adapterSpecFor, type AdapterSpec, type AgentKind } from "./adapters.js";
import { SlidraError } from "../slidra/errors.js";

/** Upper bound on how long a login-status probe may run before it counts as a failure (NOOP-230 §4.2). */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * Upper bound on the ACP `initialize` handshake (E10.T6/#400 D3, AC3): a
 * declared command that starts but never speaks ACP must fail with a named
 * reason within a bounded time, never hang forever. Overridable via
 * `SLIDRA_ACP_HANDSHAKE_TIMEOUT_MS` — read lazily by `withAcpHandshakeTimeout`
 * below, not baked in at module load, so a test can set it right before
 * triggering a handshake without needing to control import order.
 */
export const ACP_HANDSHAKE_TIMEOUT_MS = 10_000;

function resolveHandshakeTimeoutMs(): number {
  const override = Number(process.env.SLIDRA_ACP_HANDSHAKE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : ACP_HANDSHAKE_TIMEOUT_MS;
}

/**
 * Races `work` against a timeout, rejecting with a `SlidraError` naming
 * `label` and the bound if `work` never settles in time — the one thing
 * that makes a declared adapter which starts but never speaks ACP a named
 * failure instead of a permanent hang (AC3). `work` itself is never
 * cancelled (there is no way to cancel a pending JSON-RPC call), only
 * raced: a `work` that eventually does settle after the timeout has no
 * further effect here.
 */
export function withAcpHandshakeTimeout<T>(label: string, work: Promise<T>, timeoutMs: number = resolveHandshakeTimeoutMs()): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new SlidraError(
          `${label} did not complete its ACP handshake within ${timeoutMs}ms — it may not be an ACP-over-stdio server.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
export async function probeLogin(kind: AgentKind, run: CommandRunner, registry: readonly AdapterSpec[] = ADAPTER_SPECS): Promise<ProbeResult> {
  const probeCommand = adapterSpecFor(kind, registry).probeCommand;
  if (!probeCommand) {
    // Unreachable given every caller (`agent/manager.ts`'s `probeOne`) only
    // calls this once it has already checked the spec has a `probeCommand`
    // — a user-declared adapter never does (E10.T6/#400 D4) and is reported
    // "available" without ever reaching here.
    throw new Error(`probeLogin called for a kind with no probeCommand: ${kind}`);
  }
  const { command, args } = probeCommand;
  const outcome = await run(command, args, PROBE_TIMEOUT_MS);

  if (outcome.code === null) {
    return { loggedIn: false, detail: truncateDetail(outcome.stderr || "Failed to run the probe command") };
  }

  if (kind !== "claude") {
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
