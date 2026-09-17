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
import { accessSync, constants } from "node:fs";
import path from "node:path";

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
 * `wrapWithSandboxArgv` hands back `["/bin/bash", "-c", "<prelude> <real
 * command>"]`, and 0.0.76's prelude opens with a BARE `env ...` — resolved
 * through whatever `PATH` the merged env below carries, not an absolute
 * path. A caller that deliberately narrows `PATH` (the e2e and agent tests
 * all do, to keep an ancestor `node_modules/.bin` from masking a broken
 * workspace link) can therefore leave the wrapper unable to start at all.
 * The failure that produces is `/bin/bash: env: command not found` on the
 * child's stderr and nothing else: no agent, no session, no edit — every
 * caller upstream just sees a turn that never happens and times out
 * whatever it was polling for, half an hour from the actual cause.
 *
 * So check the one precondition here, where the answer is still known, and
 * raise it as the author's problem rather than letting it become a silent
 * timeout. Only a bare first token is checked: an absolute path needs no
 * `PATH` to resolve, and a later `srt` that emits one makes this a no-op
 * rather than a false alarm.
 */
function assertPreludeResolvable(args: string[], env: NodeJS.ProcessEnv): void {
  const script = args[args.length - 1];
  if (script === undefined) return;
  const first = script.trim().split(/\s+/)[0];
  if (first === undefined || first === "" || first.includes("/")) return;

  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
  const found = dirs.some((dir) => {
    try {
      accessSync(path.join(dir, first), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (found) return;

  const message =
    `the macOS sandbox wrapper starts with \`${first}\`, which is not on the PATH this agent will be spawned with ` +
    `(PATH=${env.PATH ?? "<unset>"}). Add the directory holding \`${first}\` (normally /usr/bin) to that PATH.`;
  // The throw reaches the author as a `chat-error` in the browser
  // (`agent/session.ts`'s `runTurn`), which is right for someone sitting in
  // front of the UI and useless for anyone reading a terminal — a test
  // harness polling for an edit sees only a turn that never happened, and
  // spends its whole timeout finding that out. This is a misconfiguration
  // of the process, not one author's bad turn, so it also goes to the
  // server's own log where a non-UI caller will actually read it.
  console.error(`[sandbox] ${message}`);
  throw new Error(message);
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
      assertPreludeResolvable(args, { ...env, ...spawn.env });
      return {
        command,
        args,
        // `srt`'s own `env` is `process.env` verbatim on macOS (verified
        // against 0.0.76's source: the macOS/Linux branch of
        // `wrapWithSandboxArgv` returns `{ argv, env: process.env }` and adds
        // nothing to it — the proxy variables it does set are baked into the
        // wrapped command string, not into this object). So it goes FIRST and
        // the caller's own env last: spreading it last instead silently
        // overwrote every variable the caller had deliberately changed from
        // the parent's value, `PATH` above all — which is exactly the
        // variable `agent/manager.ts` rewrites to put `<sandboxRoot>/bin`
        // (the CLI-sandbox shim) ahead of any ambient `slidra`. The agent
        // then resolved `slidra` to the real binary and ran it *inside the
        // agent sandbox*, where `denyRead` covers the deck — every scripted
        // command failed, macOS only (`landlock-launcher.ts` hands the
        // caller's env straight back). Caught by the required-macos job's
        // freeze.test.ts failures, 2026-09-15.
        env: { ...env, ...spawn.env },
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
