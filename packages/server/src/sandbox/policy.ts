// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { readProjectsRegistry, resolveSlidraHome } from "../slidra/home.js";
import type { SandboxPolicy } from "./launcher.js";

const isMac = process.platform === "darwin";

/** True only for a path that exists on disk *and* is a directory — never for "does not exist" or "exists as a file". */
async function isExistingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The agent sandbox's write allow-list (NOOP-425 AC8). Every entry here is
 * something the agent's own tools (npm/pip/uv/playwright installs, `gh`/
 * `claude`/`codex` credential refresh) need to keep working with no extra
 * configuration (AC4) — the allow-list is deliberately not "the agent's
 * whole home directory", which is what makes `denyRead` below meaningful.
 *
 * `~/.config` is the widest entry: many CLIs (`gh` among them) keep
 * long-lived tokens there, and it is the one directory here that isn't
 * scoped to a single tool. Reviewed and accepted for AC4's sake, not an
 * oversight.
 */
export async function buildAgentSandboxPolicy(options: { sandboxRoot: string; home?: string }): Promise<SandboxPolicy> {
  const home = options.home ?? homedir();
  const allowWrite = [
    // The agent's own work directory and the shim wrapper live here — an
    // empty allow-list cannot run anything at all.
    options.sandboxRoot,
    tmpdir(),
    ...(isMac ? ["/private/tmp"] : []),
    // Claude Code / Codex session state and token refresh (AC4).
    path.join(home, ".claude"),
    path.join(home, ".claude.json"),
    path.join(home, ".codex"),
    // npm/pip/uv/playwright caches: read-only here would make those tools
    // hard-fail rather than merely run uncached.
    path.join(home, ".npm"),
    isMac ? path.join(home, "Library", "Caches") : path.join(home, ".cache"),
    // gh and other CLIs' token refresh — see the docstring above.
    path.join(home, ".config"),
  ];

  const slidraHome = resolveSlidraHome();
  const denyRead = [slidraHome];
  const registry = await readProjectsRegistry();
  for (const entry of registry.values()) {
    denyRead.push(entry.deckPath);
    if (entry.sourcePath !== undefined) denyRead.push(entry.sourcePath);
  }
  // T2 (NOOP-446, not yet merged) will give every deck a home under
  // `~/Slidra`; deny it once it exists so this policy does not need to
  // change when that ships. Only when it already exists *and* is a
  // directory — denying a path bwrap has to create denies T2's own mkdir
  // (a deny of a non-existent path makes bwrap mount an empty file there).
  const deckFolder = path.join(home, "Slidra");
  if (await isExistingDirectory(deckFolder)) {
    denyRead.push(deckFolder);
  }

  return { allowWrite, denyWrite: [], denyRead };
}

/**
 * The CLI sandbox's write allow-list (NOOP-425 §0's "second, reversed
 * sandbox"): the shim endpoint runs `slidra <args>` on the agent's behalf,
 * and this is what keeps `slidra extract <deck> ~/.ssh/` from actually
 * reaching `~/.ssh` — the agent sandbox's allow-list has nothing to say
 * about it, since that command's own process runs under this policy
 * instead.
 */
export function buildCliSandboxPolicy(options: { deckPath: string }): SandboxPolicy {
  const { deckPath } = options;
  return {
    allowWrite: [
      deckPath,
      `${deckPath}-wal`,
      `${deckPath}-shm`,
      `${deckPath}-journal`,
      // `projects.json`, `history/<id>/stack.json`, save-state bookkeeping.
      resolveSlidraHome(),
      // `encodeCommandArgv`'s `slidra-argv-*` mkdtemp files.
      tmpdir(),
    ],
    denyWrite: [],
    denyRead: [],
  };
}
