// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { createPassthroughLauncher } from "./passthrough-launcher.js";
import { createLandlockLauncher } from "./landlock-launcher.js";

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
 * The one seam every caller in this codebase talks to (NOOP-425 D1) — three
 * things implement it (`landlock-launcher.ts` on Linux, `srt-launcher.ts`'s
 * Seatbelt path on macOS, `passthrough-launcher.ts` everywhere isolation is
 * off or unavailable), and callers never know which one they got.
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
 * Builds the launcher for this `serve` process (NOOP-425 D8, platform
 * dispatch per the 2026-09-15 owner decision): forced off via
 * `SLIDRA_SANDBOX=off`, Linux uses the kernel's own Landlock LSM
 * (`landlock-launcher.ts` — no bubblewrap, no user namespace, no root),
 * macOS keeps `@anthropic-ai/sandbox-runtime`'s Seatbelt path, and Windows
 * has no OS-level code path at all (by design). A dependency/init/self-check
 * failure on either real platform degrades to the passthrough launcher with
 * a reason — startup itself never fails because write isolation could not
 * be established.
 *
 * `srt-launcher.ts` is imported dynamically, only on `darwin`: Linux must
 * never load `@anthropic-ai/sandbox-runtime` at all, since its own
 * `initialize()` unconditionally requires `bwrap`/`socat` on that platform
 * (exactly the bubblewrap path this project decided against).
 */
export async function createSandboxLauncher(): Promise<SandboxLauncher> {
  if (isForcedOff()) {
    return createPassthroughLauncher("write isolation is turned off (SLIDRA_SANDBOX=off)");
  }
  if (process.platform === "win32") {
    return createPassthroughLauncher("write isolation is not available on Windows yet");
  }
  try {
    if (process.platform === "darwin") {
      const { createSrtLauncher } = await import("./srt-launcher.js");
      return await createSrtLauncher();
    }
    if (process.platform === "linux") {
      return await createLandlockLauncher();
    }
    return createPassthroughLauncher(`write isolation is not available on ${process.platform}`);
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
