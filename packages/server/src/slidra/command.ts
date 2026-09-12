import { runSlidra } from "./bin.js";

/**
 * Why a command failed, in the only distinction any caller is allowed to
 * act on — identical contract to the old `packages/cli` registry's
 * `CommandFailureKind` (`"not-found"` positively proves absence,
 * `"failed"` is everything else). Callers never pattern-match on `message`.
 */
export type CommandFailureKind = "not-found" | "failed";

/** The outcome of running one `slidra` command, in the same shape the old in-process `CommandRegistry.dispatch` returned. */
export interface CommandResult<Data = unknown> {
  ok: boolean;
  data?: Data;
  message: string;
  failureKind?: CommandFailureKind;
}

interface JsonEnvelope {
  ok: boolean;
  data?: unknown;
  message: string;
  failureKind?: CommandFailureKind;
}

/**
 * Parses stdout as `crates/slidra/src/result.rs`'s `JsonEnvelope`: one
 * line of compact JSON (§3.2). Anything else — empty output, multiple
 * lines (a panic dumped extra text, or a stray print), invalid JSON, or
 * valid JSON missing the required `ok`/`message` fields — is not a legal
 * envelope and returns `null`.
 */
function parseEnvelope(stdout: string): JsonEnvelope | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as { ok?: unknown; message?: unknown };
  if (typeof candidate.ok !== "boolean" || typeof candidate.message !== "string") {
    return null;
  }
  return parsed as JsonEnvelope;
}

/**
 * Runs one `slidra` command with `--json` (always appended as the very
 * last argv token — §3.4's "the last `--json` wins" legacy-takeover rule)
 * and turns its stdout into a `CommandResult`.
 *
 * Exit-code-blind by design (§3.3): `--json`'s failure path currently exits
 * 0, a known Rust/spec mismatch this ticket does not fix. Whether stdout
 * parses as a legal envelope is the only signal trusted — a non-zero exit
 * with a legal `ok:true` envelope (e.g. an EPIPE after the real work
 * finished) is still success; a zero exit with unparseable stdout is still
 * `ok:false`.
 */
export async function runJsonCommand<Data = unknown>(args: string[]): Promise<CommandResult<Data>> {
  const { stdout, stderr } = await runSlidra([...args, "--json"]);
  const envelope = parseEnvelope(stdout);
  if (envelope === null) {
    const message = stderr.trim();
    return { ok: false, message: message.length > 0 ? message : "命令執行失敗" };
  }
  if (envelope.ok) {
    return { ok: true, data: envelope.data as Data, message: envelope.message };
  }
  return { ok: false, message: envelope.message, failureKind: envelope.failureKind };
}
