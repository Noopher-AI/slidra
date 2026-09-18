// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveSlidraHome } from "../slidra/home.js";
import type { FsRule, SandboxContext, WorkbenchPolicy } from "../policy/types.js";
import type { SandboxConfig } from "./launcher.js";
import { ADAPTER_SPECS } from "../agent/adapters.js";

/** Every *bundled* adapter's own `writeRules`, concatenated in `ADAPTER_SPECS`'s order — `collectSandboxContext`'s default for `adapterWriteRules` (AC2: unchanged unless a caller explicitly overrides it). */
const DEFAULT_ADAPTER_WRITE_RULES: readonly FsRule[] = ADAPTER_SPECS.flatMap((spec) => spec.writeRules);

/** True only for a path that exists on disk *and* is a directory — never for "does not exist" or "exists as a file". */
async function isExistingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Gathers the facts one workbench's `FsRule`s resolve against — the only
 * I/O in this whole module. `deriveSandboxConfig`/`deriveCliSandboxConfig`
 * below take the result and stay pure, synchronous, zero-I/O (AC2):
 * calling this once and deriving twice against two different policies must
 * produce two different configs for reasons that trace only to the policy,
 * never to a second disk read racing the first.
 */
export async function collectSandboxContext(options: {
  workbenchRoot: string;
  home?: string;
  deckPath?: string;
  /** Resolved into `ctx.adapterStateDirs`. Defaults to every *bundled* adapter's own `writeRules` concatenated (`agent/adapters.ts`'s `ADAPTER_SPECS`) — a caller that never overrides this sees byte-identical `adapterStateDirs` to before E10.T6 (AC2). */
  adapterWriteRules?: readonly FsRule[];
}): Promise<SandboxContext> {
  const home = options.home ?? homedir();
  const slidraHome = resolveSlidraHome();
  const platform = process.platform;

  const candidateDeckFolder = path.join(home, "Slidra");
  const deckFolder = (await isExistingDirectory(candidateDeckFolder)) ? candidateDeckFolder : null;

  // `resolveFsRule` only needs `home`/`platform` for the kinds a
  // adapter's `writeRules` ever uses (`homeEntry`/`literal`) — safe to
  // resolve against a context whose own `adapterStateDirs` is still empty.
  const adapterStateDirs = resolveFsRules(options.adapterWriteRules ?? DEFAULT_ADAPTER_WRITE_RULES, {
    workbenchRoot: options.workbenchRoot,
    home,
    tempDir: tmpdir(),
    platform,
    slidraHome,
    openDeckPaths: [],
    deckFolder,
    deckDirectory: options.deckPath !== undefined ? path.dirname(options.deckPath) : null,
    adapterStateDirs: [],
  });

  return {
    workbenchRoot: options.workbenchRoot,
    home,
    tempDir: tmpdir(),
    platform,
    slidraHome,
    openDeckPaths: [],
    deckFolder,
    deckDirectory: options.deckPath !== undefined ? path.dirname(options.deckPath) : null,
    adapterStateDirs,
  };
}

/**
 * Resolves one `FsRule` against `ctx` into zero or more real paths. Pure,
 * synchronous — every fact it needs is already sitting in `ctx`. The
 * `exhaustive` check at the bottom is what makes an unknown `FsRule.kind`
 * an editor-time (and, failing that, a runtime) error rather than a
 * silently-ignored rule — this file's own behaviour contract (`##4` in the
 * plan) requires that, not a quietly empty allow-list entry.
 */
function resolveFsRule(rule: FsRule, ctx: SandboxContext): readonly string[] {
  switch (rule.kind) {
    case "workbenchRoot":
      return [ctx.workbenchRoot];
    case "tempDir":
      return [ctx.tempDir];
    case "slidraHome":
      return [ctx.slidraHome];
    case "openDeckPaths":
      return ctx.openDeckPaths;
    case "deckFolderIfPresent":
      return ctx.deckFolder === null ? [] : [ctx.deckFolder];
    case "deckDirectory":
      if (ctx.deckDirectory === null) {
        throw new Error("sandbox policy: a 'deckDirectory' rule was resolved against a context with no deck path");
      }
      return [ctx.deckDirectory];
    case "literal":
      if (rule.onlyOn !== undefined && rule.onlyOn !== ctx.platform) return [];
      return [rule.path];
    case "homeEntry":
      if (rule.onlyOn !== undefined && rule.onlyOn !== ctx.platform) return [];
      return [path.join(ctx.home, ...rule.segments)];
    case "adapterState":
      return ctx.adapterStateDirs;
    default: {
      const exhaustive: never = rule;
      throw new Error(`sandbox policy: unknown FsRule kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function resolveFsRules(rules: readonly FsRule[], ctx: SandboxContext): string[] {
  const out: string[] = [];
  for (const rule of rules) out.push(...resolveFsRule(rule, ctx));
  return out;
}

/**
 * The agent sandbox's configuration, as a pure function of `policy` and
 * `ctx` (AC2, `#399` arch 2) — the same `policy` against the same `ctx`
 * always yields the same result, and a different `policy` against the same
 * `ctx` is the only thing that can change it.
 */
export function deriveSandboxConfig(policy: WorkbenchPolicy, ctx: SandboxContext): SandboxConfig {
  return {
    allowWrite: resolveFsRules(policy.filesystem.allowWrite, ctx),
    denyWrite: resolveFsRules(policy.filesystem.denyWrite, ctx),
    denyRead: resolveFsRules(policy.filesystem.denyRead, ctx),
    network: policy.network,
  };
}

/**
 * The CLI sandbox's configuration (NOOP-425 §0's "second, reversed
 * sandbox"): same derivation, `policy.filesystem.cliAllowWrite` instead of
 * `allowWrite`, and no write/read deny-list — the CLI sandbox has never had
 * one (`buildCliSandboxPolicy`'s pre-existing behaviour).
 */
export function deriveCliSandboxConfig(policy: WorkbenchPolicy, ctx: SandboxContext): SandboxConfig {
  return {
    allowWrite: resolveFsRules(policy.filesystem.cliAllowWrite, ctx),
    denyWrite: [],
    denyRead: [],
    network: policy.network,
  };
}

/**
 * The current process's one active policy (NOOP-617) — a module-level
 * singleton for the same reason `launcher.ts`'s `setActiveLauncher` is one:
 * `buildCliSandboxPolicy` below may only be touched at its existing call
 * site (`shim-endpoint.ts`, zero changes there — [E10.T2]'s file), which
 * has no policy object to pass in directly. `serve.ts` is the only writer;
 * every other reader only ever reads.
 */
let activePolicy: WorkbenchPolicy | undefined;

export function setActivePolicy(policy: WorkbenchPolicy | undefined): void {
  activePolicy = policy;
}

export function getActivePolicy(): WorkbenchPolicy | undefined {
  return activePolicy;
}

/**
 * The CLI sandbox's write allow-list (NOOP-425 §0's "second, reversed
 * sandbox"): the shim endpoint runs `slidra <args>` on the agent's behalf,
 * and this is what keeps `slidra extract <deck> ~/.ssh/` from actually
 * reaching `~/.ssh` — the agent sandbox's allow-list has nothing to say
 * about it, since that command's own process runs under this policy
 * instead.
 *
 * Signature unchanged (NOOP-617 plan §7 decision 3 — `shim-endpoint.ts`
 * imports only this function, never a type, and must stay a zero-diff
 * file): reads the active policy set by `serve.ts`'s `setActivePolicy`
 * rather than taking one as a parameter. Building `ctx` here needs no I/O
 * — `deckDirectory` is a plain `path.dirname`, `slidraHome`/`tempDir` need
 * no filesystem access — so this can stay synchronous exactly as before.
 */
export function buildCliSandboxPolicy(): SandboxConfig {
  const policy = getActivePolicy();
  if (policy === undefined) {
    throw new Error("buildCliSandboxPolicy: no active policy — setActivePolicy must be called before serve starts routing requests");
  }
  const ctx: SandboxContext = {
    workbenchRoot: "",
    home: homedir(),
    tempDir: tmpdir(),
    platform: process.platform,
    slidraHome: resolveSlidraHome(),
    openDeckPaths: [],
    deckFolder: null,
    deckDirectory: null,
    adapterStateDirs: [],
  };
  return deriveCliSandboxConfig(policy, ctx);
}
