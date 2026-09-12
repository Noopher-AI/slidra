// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { SlidraError } from "./errors.js";
import { resolveSlidraHome, workDirFor } from "./home.js";

/**
 * `<SLIDRA_HOME>/history/<id>/stack.json`'s open-group bookkeeping,
 * ported from `packages/core`'s `history.ts` (`beginHistoryGroup`/
 * `endHistoryGroup` only — every other history operation now goes through
 * the `slidra` binary's own `undo`/`redo` commands).
 *
 * `crates/slidra/src/history.rs:629`'s own comment documents this
 * exact co-existence: the Rust binary's own commands append onto whatever
 * group this module leaves open in `stack.json`, and close it themselves
 * only when there is none — the two are deliberately reading and writing
 * the *same* file's `openGroup` field, not two independent stores. No CLI
 * command exposes "open" or "close a group" (`begin_history_group`/
 * `end_history_group` are `pub(crate)` in Rust), so this server-side copy
 * is the only way `agent/session.ts`'s one-history-group-per-turn contract
 * can be honoured.
 */

interface HistoryEntry {
  virtualPath: string;
  snapshotId: string | null;
}

interface HistoryGroup {
  groupId: string;
  entries: HistoryEntry[];
}

interface StackFile {
  undo: HistoryGroup[];
  redo: HistoryGroup[];
  openGroup: HistoryGroup | null;
}

/** Same cap as `packages/core`'s `history.ts` — an unbounded undo stack is a disk leak with no exit. */
const UNDO_STACK_CAP = 50;

function historyDirFor(home: string, id: string): string {
  return path.join(home, "history", id);
}

function stackPath(home: string, id: string): string {
  return path.join(historyDirFor(home, id), "stack.json");
}

function snapshotPath(home: string, id: string, snapshotId: string): string {
  return path.join(historyDirFor(home, id), "snapshots", snapshotId);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as HistoryEntry).virtualPath === "string" &&
    (typeof (value as HistoryEntry).snapshotId === "string" || (value as HistoryEntry).snapshotId === null)
  );
}

function isHistoryGroup(value: unknown): value is HistoryGroup {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as HistoryGroup).groupId === "string" &&
    Array.isArray((value as HistoryGroup).entries) &&
    (value as HistoryGroup).entries.every(isHistoryEntry)
  );
}

function isStackFile(value: unknown): value is StackFile {
  if (typeof value !== "object" || value === null) return false;
  const stack = value as StackFile;
  return (
    Array.isArray(stack.undo) &&
    stack.undo.every(isHistoryGroup) &&
    Array.isArray(stack.redo) &&
    stack.redo.every(isHistoryGroup) &&
    (stack.openGroup === null || isHistoryGroup(stack.openGroup))
  );
}

async function readStack(home: string, id: string): Promise<StackFile> {
  let raw: string;
  try {
    raw = await readFile(stackPath(home, id), "utf-8");
  } catch (error) {
    if (isEnoent(error)) {
      return { undo: [], redo: [], openGroup: null };
    }
    throw new SlidraError("undo history is corrupted");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SlidraError("undo history is corrupted");
  }
  if (!isStackFile(parsed)) {
    throw new SlidraError("undo history is corrupted");
  }
  return parsed;
}

async function writeStack(home: string, id: string, stack: StackFile): Promise<void> {
  const dir = historyDirFor(home, id);
  const finalPath = stackPath(home, id);
  const tempPath = path.join(dir, `.stack.json.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(stack, null, 2)}\n`);
    await rename(tempPath, finalPath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new SlidraError("failed to write undo history");
  }
}

async function deleteSnapshot(home: string, id: string, snapshotId: string): Promise<void> {
  try {
    await rm(snapshotPath(home, id, snapshotId), { force: true });
  } catch {
    throw new SlidraError("failed to delete undo snapshot");
  }
}

/** Pushes a group onto the undo stack and enforces `UNDO_STACK_CAP`, returning any evicted group's snapshot ids. */
function pushGroupToUndoStack(stack: StackFile, group: HistoryGroup): string[] {
  stack.undo.push(group);
  const evictedSnapshotIds: string[] = [];
  while (stack.undo.length > UNDO_STACK_CAP) {
    const evicted = stack.undo.shift()!;
    for (const entry of evicted.entries) {
      if (entry.snapshotId !== null) evictedSnapshotIds.push(entry.snapshotId);
    }
  }
  return evictedSnapshotIds;
}

function generateGroupId(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Opens a group that spans multiple commands (an agent's turn) so they undo
 * together as one step. Returns `true` when this call is the one that
 * opened the group — the caller owns it and MUST call `endHistoryGroup` in
 * a `finally` block. Returns `false` when a group was already open — the
 * caller has joined it and MUST NOT close it.
 */
export async function beginHistoryGroup(id: string): Promise<boolean> {
  const home = resolveSlidraHome();
  await workDirFor(id);
  const stack = await readStack(home, id);
  if (stack.openGroup) {
    return false;
  }
  stack.openGroup = { groupId: generateGroupId(), entries: [] };
  await writeStack(home, id, stack);
  return true;
}

/**
 * Closes the group opened by `beginHistoryGroup` and pushes it onto the
 * undo stack as one step. An empty group (no command in it ever wrote
 * anything) is discarded rather than pushed.
 */
export async function endHistoryGroup(id: string): Promise<void> {
  const home = resolveSlidraHome();
  await workDirFor(id);
  const stack = await readStack(home, id);
  const group = stack.openGroup;
  if (!group) {
    throw new SlidraError("no open undo group");
  }
  stack.openGroup = null;
  const evictedSnapshotIds = group.entries.length > 0 ? pushGroupToUndoStack(stack, group) : [];
  await writeStack(home, id, stack);
  for (const snapshotId of evictedSnapshotIds) {
    await deleteSnapshot(home, id, snapshotId);
  }
}
