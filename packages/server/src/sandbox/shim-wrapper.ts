// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * `../../shim/slidra-shim.mjs`, resolved relative to this module's own
 * location — the same trick `agent/workdir.ts`'s `resolveAgentWorkdirSource`
 * and `serve.ts`'s `resolveWebDist` use, and for the same reason: it works
 * unmodified whether this file is running from `src/` or `dist/`, since
 * both sit the same two levels under `packages/server/`.
 */
export function resolveShimScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "../../shim/slidra-shim.mjs");
}

/**
 * Writes `<sandboxRoot>/bin/slidra` (NOOP-425 D5): a two-line POSIX shell
 * wrapper that `exec`s the real shim script under this exact Node binary.
 * `agent/session.ts` prepends `<sandboxRoot>/bin` to the spawned agent's
 * `PATH`, so every `slidra` the agent's shell resolves is this wrapper, not
 * whatever (if anything) is installed globally.
 *
 * Written once per `serve` process, alongside the sandbox root itself —
 * every presentation's own subdirectory sits next to this one `bin/`, so
 * switching decks never needs to redeploy it.
 */
export async function deployShimWrapper(sandboxRoot: string): Promise<void> {
  const binDir = path.join(sandboxRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, "slidra");
  const scriptPath = resolveShimScriptPath();
  await writeFile(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  await chmod(wrapperPath, 0o755);
}
