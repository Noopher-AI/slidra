import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoMotionError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * `execFile`'s default `maxBuffer` is 1 MiB — `/api/raw/` reading a large
 * font or media asset through `cat --json` (base64-encoded, ~1.33x the
 * original bytes) blows straight through that (plan §3.10). Same order of
 * magnitude headroom as `asset-upload.ts`'s own `MAX_ASSET_BODY_BYTES`,
 * doubled for the base64 expansion.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Resolves the Rust `comotion` binary's path from `COMOTION_BIN`. Never
 * falls back to searching `PATH` — `docs/spec/cli.md`'s environment
 * variables section is explicit that an unset `COMOTION_BIN` is a hard
 * error, not a "try to find one" opportunity. On the real `comotion serve`
 * startup path this is always set (the Rust launcher sets it via
 * `current_exe` before exec'ing Node); tests set it themselves to point at
 * a fake binary.
 */
export function resolveCoMotionBin(): string {
  const bin = process.env.COMOTION_BIN;
  if (!bin) {
    throw new CoMotionError("未設定 COMOTION_BIN，無法執行 comotion 命令");
  }
  return bin;
}

export interface CoMotionProcessResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs the `comotion` binary and returns its raw stdout/stderr —
 * regardless of exit code (§3.3: `--json` failures currently exit 0, so
 * exit code carries no information `runJsonCommand` can trust either way).
 * Only a genuine failure to even start the process (the binary path does
 * not exist, is not executable, ...) throws.
 */
export async function runCoMotion(args: string[]): Promise<CoMotionProcessResult> {
  const bin = resolveCoMotionBin();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // A non-zero exit still carries stdout/stderr for runJsonCommand to
    // parse (envelope-first, exit-code-blind — §3.3). Only the absence of
    // both means the process never actually produced output at all — a
    // real spawn failure (ENOENT, EACCES, ...), not a command that ran and
    // reported `ok:false`.
    if (typeof err.stdout === "string" || typeof err.stderr === "string") {
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    // COMOTION_BIN's value is never echoed here (ADR-0004): it may be a
    // real filesystem path a test or a misconfigured environment pointed
    // somewhere that leaks host layout.
    throw new CoMotionError("無法執行 comotion");
  }
}
