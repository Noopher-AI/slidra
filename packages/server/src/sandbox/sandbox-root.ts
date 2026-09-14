// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * One `slidra serve` process's own scratch tree for the agent sandbox
 * (NOOP-425 D4): `<os.tmpdir()>/slidra-sandbox-<per-serve uuid>/`. Everything
 * the sandboxed agent is allowed to write lives under here — the deployed
 * agent work directory (`agent/workdir.ts`'s `deployAgentWorkdir`), and the
 * shim wrapper (`<root>/bin/slidra`).
 *
 * Per-serve rather than shared (the old `<SLIDRA_HOME>/agent` location) is
 * what makes two `slidra serve` processes on one machine structurally unable
 * to collide: each gets its own root, so there is no "retire the previous
 * generation" problem to solve at all — a fresh root is simply empty.
 */
export interface SandboxRoot {
  /** The root directory itself — this is `SandboxPolicy.allowWrite`'s one entry that always exists. */
  readonly path: string;
  /** `<root>/<presentationId>` — where `deployAgentWorkdir` deploys one presentation's work directory. */
  presentationDir(presentationId: string): string;
  /**
   * Removes one presentation's subdirectory only, leaving the rest of the
   * root (and any other presentation's subdirectory) untouched — the
   * "switching decks" half of AC9. Never throws on an already-absent
   * directory: a deck that was never opened in this sandbox has nothing to
   * remove.
   */
  disposePresentation(presentationId: string): Promise<void>;
  /**
   * Removes the whole root — the "exiting the program" half of AC9. Safe to
   * call more than once.
   */
  disposeAll(): Promise<void>;
}

/** Creates a fresh, empty sandbox root for this `serve` process. */
export async function createSandboxRoot(): Promise<SandboxRoot> {
  const root = path.join(tmpdir(), `slidra-sandbox-${randomUUID()}`);
  await mkdir(root, { recursive: true });

  return {
    path: root,
    presentationDir(presentationId: string): string {
      return path.join(root, presentationId);
    },
    async disposePresentation(presentationId: string): Promise<void> {
      await rm(path.join(root, presentationId), { recursive: true, force: true });
    },
    async disposeAll(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}
