// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { SandboxConfig, SandboxLauncher, SandboxSpawn, WrappedSpawn } from "./launcher.js";

/**
 * The degraded/off launcher (NOOP-425 D8): `wrap()` returns the spawn
 * unchanged, `active` is always false. Every caller of `SandboxLauncher`
 * goes through this exact same interface whether isolation is on or off —
 * `agent/session.ts`'s two call sites never branch on which launcher they
 * got, only on `active` (for the permission-policy short-circuit).
 */
export function createPassthroughLauncher(reason: string): SandboxLauncher {
  return {
    active: false,
    degradedReason: reason,
    enforces: { write: false, network: false },
    wrap(spawn: SandboxSpawn, _policy: SandboxConfig): Promise<WrappedSpawn> {
      return Promise.resolve({
        command: spawn.command,
        args: [...spawn.args],
        env: spawn.env,
        shell: false,
        ...(spawn.cwd === undefined ? {} : { cwd: spawn.cwd }),
      });
    },
    dispose(): Promise<void> {
      return Promise.resolve();
    },
  };
}
