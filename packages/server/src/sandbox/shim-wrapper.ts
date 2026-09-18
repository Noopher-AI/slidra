// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveSlidraBin } from "../slidra/bin.js";

/**
 * Writes `<sandboxRoot>/bin/slidra` (NOOP-425 D5): a two-line POSIX shell
 * wrapper that `exec`s the Rust `slidra` binary's own `__shim` entry point
 * — [S11.F2] replaces `../../shim/slidra-shim.mjs` (deleted this ticket)
 * with `crates/slidra/src/server/shim_client.rs`, so the client side of
 * this hop has no Node process in it at all any more. `agent/session.ts`
 * prepends `<sandboxRoot>/bin` to the spawned agent's `PATH`, so every
 * `slidra` the agent's shell resolves is this wrapper, not whatever (if
 * any) is installed globally.
 *
 * `shim_client.rs`'s own module doc explains why this is safe to change
 * without retargeting anything else: it speaks the SAME
 * `POST /api/agent/exec` wire protocol `slidra-shim.mjs` did whenever
 * `SLIDRA_SHIM_TOKEN` is set (which `agent/manager.ts`, unchanged, always
 * is, live) — the deck server's own new protocol
 * (`SLIDRA_SHIM_CREDENTIAL`) is unused by anything in this repo yet.
 *
 * Written once per `serve` process, alongside the sandbox root itself —
 * every presentation's own subdirectory sits next to this one `bin/`, so
 * switching decks never needs to redeploy it.
 */
export async function deployShimWrapper(sandboxRoot: string): Promise<void> {
  const binDir = path.join(sandboxRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, "slidra");
  const slidraBin = resolveSlidraBin();
  await writeFile(wrapperPath, `#!/bin/sh\nexec "${slidraBin}" __shim "$@"\n`);
  await chmod(wrapperPath, 0o755);
}
