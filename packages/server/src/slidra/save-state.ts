// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import path from "node:path";
import { SlidraNotFoundError } from "./errors.js";
import { maxMtimeInDirectory, readProjectsRegistry } from "./home.js";

export type SaveState = { known: true; dirty: boolean; fileName: string } | { known: false };

/**
 * Reports whether presentation `id`'s work directory has changed since it
 * was last known to match `sourcePath` — ported from `packages/core`'s
 * `readSaveState` (see that module's comment for the full "changed"
 * definition and the strict-`>` tie-breaking rule this relies on), with
 * one addition: both sides of the comparison are floored to whole
 * milliseconds first.
 *
 * `savedAt` is written by the Rust binary's `pack` command
 * (`crates/slidra/src/workspace/mod.rs`'s `mtime_millis`, via
 * `duration.as_secs_f64() * 1000.0`) and read back here as a JS `number`;
 * `maxMtimeInDirectory` below computes the comparison side from the same
 * underlying filesystem mtime through Node's `fs.stat().mtimeMs`. Both
 * conceptually convert the same nanosecond-precision OS timestamp to a
 * float64 milliseconds value, but via different arithmetic (seconds-as-f64
 * scaled by 1000 in Rust vs. Node's own internal ns→ms conversion) — for
 * some nanosecond values these produce a result that differs in the last
 * representable fractional digit (observed directly: immediately after
 * `POST /api/save`, `maxMtimeInDirectory` read back a value ~0.0001ms
 * above the very `savedAt` the same `pack` call had just written from the
 * same unchanged files, permanently pinning `dirty: true`). Flooring both
 * values away removes that cross-runtime noise; it does not weaken the
 * "changed since last save" guarantee itself — an edit landing in the same
 * whole millisecond as the save it follows is already an unrepresentable
 * race in a millisecond-resolution field, not a case this comparison could
 * ever have distinguished either way.
 */
export async function readSaveState(id: string): Promise<SaveState> {
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) {
    throw new SlidraNotFoundError(`no presentation found for id: ${id}`);
  }
  if (entry.sourcePath === undefined || entry.savedAt === undefined) {
    return { known: false };
  }
  const maxMtimeMs = await maxMtimeInDirectory(entry.workDir);
  const dirty = Math.floor(maxMtimeMs) > Math.floor(entry.savedAt);
  return { known: true, dirty, fileName: path.basename(entry.sourcePath) };
}
