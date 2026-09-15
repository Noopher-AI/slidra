// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

/**
 * The macOS half of the agent sandbox (NOOP-425 owner decision,
 * 2026-09-15): `launcher.ts` reaches this module only via a dynamic
 * `import()`, and only when `process.platform === "darwin"` — Linux uses
 * `landlock-launcher.ts` instead of `srt`'s bubblewrap path (`initialize()`
 * unconditionally requires `bwrap`/`socat` there, which needs an
 * unprivileged user namespace most Linux users' machines disable by
 * default), and Windows has no OS-level path at all. This is also the one
 * file in this codebase allowed to import `@anthropic-ai/sandbox-runtime`
 * (NOOP-425 D1) — everything else talks to `SandboxLauncher` (`launcher.ts`),
 * never to `SandboxManager` or its config types directly. `srt`'s own
 * shapes are unreviewed Beta internals (its own source:
 * `customConfig.filesystem` replaces wholesale rather than merging,
 * `network.allowedDomains` rejects wildcard patterns, `initialize()` runs no
 * zod validation on its input) — confining them to this one module is what
 * keeps a later `srt` upgrade from being a whole-codebase diff.
 */
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxLauncher, SandboxPolicy, SandboxSpawn, WrappedSpawn } from "./launcher.js";

/**
 * Quotes one argv element for `/bin/sh -c`: wraps in single quotes, and
 * closes/reopens the quote around any embedded single quote (the standard
 * POSIX trick — a single-quoted string cannot itself contain a `'`).
 * `wrapWithSandboxArgv` takes the whole command as one shell string, not an
 * argv array, so this is what keeps an argument containing a space or a
 * shell metacharacter from being split or interpreted.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommand(spawn: SandboxSpawn): string {
  return [spawn.command, ...spawn.args].map(shellQuote).join(" ");
}

/**
 * `network.allowedDomains` is a required field in `srt`'s own type, but
 * omitting the whole `network` key (verified against 0.0.76's source) is
 * what actually means "no network restriction at all" —
 * `needsNetworkRestriction` comes back false, and macOS/Linux each skip
 * every network-isolation code path outright (NOOP-456 plan D2). Passing
 * `{}` is therefore correct *at runtime* even though the exported
 * `NetworkConfig` type demands `allowedDomains`; `initialize()` itself runs
 * no zod validation on its input (also verified against 0.0.76's source),
 * so this cast is the only place that gap between the real contract and the
 * published type needs to be bridged.
 */
function buildRuntimeConfig(policy: SandboxPolicy): SandboxRuntimeConfig {
  return {
    network: {},
    filesystem: {
      allowWrite: [...policy.allowWrite],
      denyWrite: [...policy.denyWrite],
      denyRead: [...policy.denyRead],
    },
  } as SandboxRuntimeConfig;
}

export async function createSrtLauncher(): Promise<SandboxLauncher> {
  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length > 0) {
    throw new Error(`sandbox dependencies not available: ${deps.errors.join(", ")}`);
  }
  // An empty filesystem policy at startup — every real `wrap()` call passes
  // its own policy via `customConfig`, which `srt` treats as a full
  // replacement, not a merge (D1/D3): this initial shape is never actually
  // used to run anything.
  await SandboxManager.initialize(buildRuntimeConfig({ allowWrite: [], denyWrite: [], denyRead: [] }));

  let disposed = false;

  return {
    active: true,
    degradedReason: null,
    async wrap(spawn: SandboxSpawn, policy: SandboxPolicy): Promise<WrappedSpawn> {
      if (disposed) {
        throw new Error("sandbox launcher already disposed");
      }
      const config = buildRuntimeConfig(policy);
      const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
        buildShellCommand(spawn),
        undefined,
        config,
        undefined,
        spawn.cwd,
      );
      const [command, ...args] = argv;
      if (command === undefined) {
        throw new Error("sandbox runtime returned an empty argv");
      }
      return {
        command,
        args,
        env: { ...spawn.env, ...env },
        shell: false,
        ...(spawn.cwd === undefined ? {} : { cwd: spawn.cwd }),
      };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await SandboxManager.reset();
    },
  };
}
