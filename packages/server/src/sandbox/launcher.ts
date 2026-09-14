// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createSrtLauncher } from "./srt-launcher.js";
import { createPassthroughLauncher } from "./passthrough-launcher.js";

/**
 * A write allow/deny-list plus a read deny-list, in the shape every
 * `SandboxLauncher.wrap()` call takes. Deliberately a plain object of
 * strings — never `SandboxManager`'s own config shape (`srt-launcher.ts` is
 * the only file allowed to import `@anthropic-ai/sandbox-runtime` at all;
 * see its own docstring) and never anything from `srt`'s Beta internals.
 */
export interface SandboxPolicy {
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
  readonly denyRead: readonly string[];
}

/** What one command invocation needs to become a spawnable process. */
export interface SandboxSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** What `wrap()` hands back — everything `node:child_process.spawn` needs, plus whether the result must run through a shell. */
export interface WrappedSpawn {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly shell: boolean;
  readonly cwd?: string;
}

/**
 * The one seam every caller in this codebase talks to (NOOP-425 D1) —
 * `srt-launcher.ts`'s real, OS-enforced implementation and
 * `passthrough-launcher.ts`'s inert one are the only two things that
 * implement it, and callers never know which one they got.
 */
export interface SandboxLauncher {
  /** False whenever write isolation is not actually enforced — forced off, an unsupported platform, or a dependency/init failure. */
  readonly active: boolean;
  /** Human-readable reason, set whenever `active` is false; null exactly when `active` is true. */
  readonly degradedReason: string | null;
  wrap(spawn: SandboxSpawn, policy: SandboxPolicy): Promise<WrappedSpawn>;
  dispose(): Promise<void>;
}

/** `SLIDRA_SANDBOX=off` forces write isolation off regardless of platform support — the escape hatch (D8). */
function isForcedOff(): boolean {
  return process.env.SLIDRA_SANDBOX === "off";
}

/**
 * Builds the launcher for this `serve` process (NOOP-425 D8): forced off via
 * `SLIDRA_SANDBOX=off`, an unsupported platform (Windows — no srt code path
 * is written for it, by design), or a dependency/`initialize()` failure all
 * degrade to the passthrough launcher with a reason — startup itself never
 * fails because write isolation could not be established.
 */
export async function createSandboxLauncher(): Promise<SandboxLauncher> {
  if (isForcedOff()) {
    return createPassthroughLauncher("write isolation is turned off (SLIDRA_SANDBOX=off)");
  }
  if (process.platform === "win32") {
    return createPassthroughLauncher("write isolation is not available on Windows yet");
  }
  try {
    return await createSrtLauncher();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createPassthroughLauncher(`write isolation failed to start: ${message}`);
  }
}

/**
 * The current process's one active launcher, if `serve.ts` has built one.
 * A module-level singleton rather than a constructor parameter because
 * `agent/session.ts` may only be touched at its two call sites (NOOP-456
 * plan §1) — adding a constructor parameter there would ripple into
 * `agent/manager.ts`'s `buildSession()`, which the plan does not authorize.
 * `serve.ts` is the only writer; every other reader only ever reads.
 */
let activeLauncher: SandboxLauncher | undefined;

export function setActiveLauncher(launcher: SandboxLauncher | undefined): void {
  activeLauncher = launcher;
}

export function getActiveLauncher(): SandboxLauncher | undefined {
  return activeLauncher;
}
