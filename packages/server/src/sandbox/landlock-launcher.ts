// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * The Linux half of the agent sandbox (NOOP-425 owner decision,
 * 2026-09-15): wraps a command through `slidra-sandbox-exec`
 * (`crates/slidra/src/bin/sandbox_exec.rs`), the Rust helper that applies a
 * Landlock write-only ruleset to itself and then `exec()`s in place. This
 * module never touches the `landlock` crate or any OS syscall directly —
 * that lives entirely in the Rust binary, which is the only thing that
 * actually needs to run on the machine being restricted.
 *
 * `SandboxPolicy.denyRead`/`denyWrite` are deliberately ignored here: a
 * Landlock ruleset built from `AccessFs::from_write` (the helper's own
 * choice, and the one this project has decided on — AC3 requires the
 * network path open, and AC2's read refusal is `protected-paths.ts`'s job)
 * has no read-restriction or extra-deny concept to apply them to. `policy.ts`
 * still computes `denyRead` because `srt-launcher.ts` (macOS) uses it.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSlidraBin } from "../slidra/bin.js";
import type { SandboxConfig, SandboxLauncher, SandboxSpawn, WrappedSpawn } from "./launcher.js";

/**
 * The helper's own path: `SLIDRA_SANDBOX_BIN` when set (tests point this at
 * a fixture), otherwise the same-name sibling of the real `slidra` binary
 * (`crates/slidra`'s `[[bin]]` targets are built into the same directory).
 */
function resolveHelperPath(): string {
  return process.env.SLIDRA_SANDBOX_BIN ?? path.join(path.dirname(resolveSlidraBin()), "slidra-sandbox-exec");
}

/**
 * Builds the Landlock launcher, having first proved (not merely assumed)
 * that it actually restricts something on this machine — `slidra-sandbox-
 * exec --self-check` writes to an allowed and a blocked directory it made
 * itself and only succeeds if the first worked and the second failed. Any
 * failure here (missing helper, self-check non-zero, self-check refuses to
 * even run) throws, and `createSandboxLauncher()` (the only caller) turns
 * that into a degraded passthrough launcher with the reason attached —
 * never a startup failure.
 */
export async function createLandlockLauncher(): Promise<SandboxLauncher> {
  const helperPath = resolveHelperPath();
  const scratchDir = await mkdtemp(path.join(tmpdir(), "slidra-landlock-selfcheck-"));
  try {
    const result = spawnSync(helperPath, ["--self-check", scratchDir], { encoding: "utf8" });
    if (result.error) {
      throw new Error(`could not run the Landlock helper (${helperPath}): ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`Landlock self-check failed: ${result.stderr.trim() || `exit code ${String(result.status)}`}`);
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }

  let disposed = false;

  return {
    active: true,
    degradedReason: null,
    // A write-only Landlock ruleset has no network-restriction concept
    // (this module's own docstring) — `network` is always false here,
    // regardless of what any policy asks for.
    enforces: { write: true, network: false },
    wrap(spawn: SandboxSpawn, policy: SandboxConfig): Promise<WrappedSpawn> {
      if (disposed) {
        throw new Error("sandbox launcher already disposed");
      }
      const args: string[] = [];
      for (const allowed of policy.allowWrite) {
        args.push("--allow-write", allowed);
      }
      args.push("--", spawn.command, ...spawn.args);
      return Promise.resolve({
        command: helperPath,
        args,
        env: spawn.env,
        shell: false,
        ...(spawn.cwd === undefined ? {} : { cwd: spawn.cwd }),
      });
    },
    dispose(): Promise<void> {
      disposed = true;
      return Promise.resolve();
    },
  };
}
