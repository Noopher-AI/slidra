import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CoMotionError } from "./errors.js";
import { generateOpaqueId } from "./id.js";
import { resolveCoMotionHome, resolveWorkDir } from "./workspace.js";
import { readVirtualFile, resolveVirtualFilePath } from "./virtual-fs.js";

/**
 * Undo/redo for presentation content (ticket #73). Every write a command
 * makes goes through `writePresentationFile` (workspace.ts), which calls
 * `recordSnapshot` here before touching the real file — so a new command
 * gets undo for free by writing through that one door, instead of writing
 * its own inverse logic (AC 4, this is the structural guarantee).
 *
 * Storage lives at `<CO_MOTION_HOME>/history/<presentationId>/`, a sibling
 * of `work/<id>/` under the same home — never inside the work directory
 * itself, so `pack` (which zips the work directory) never picks it up
 * (AC 3). It is a snapshot store, not an inverse-operation log: an entry is
 * the complete prior content of one changed file, addressed only by its
 * virtual path and presentation id (ADR-0004) — this module has no idea
 * what a slide or an element is.
 */

export interface HistoryEntry {
  /** e.g. "slides/001.svg" */
  virtualPath: string;
  /** Filename under snapshots/. */
  snapshotId: string;
}

export interface HistoryGroup {
  groupId: string;
  entries: HistoryEntry[];
}

interface StackFile {
  undo: HistoryGroup[];
  redo: HistoryGroup[];
  openGroup: HistoryGroup | null;
}

/**
 * Undo stack depth cap. Each entry is a full copy of a changed file and
 * there is no `close` command to trigger cleanup of an open presentation's
 * history, so an unbounded stack is a disk leak with no exit. Exceeding
 * this drops the oldest group and deletes the snapshot files it referenced.
 */
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

function isHistoryGroup(value: unknown): value is HistoryGroup {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as HistoryGroup).groupId === "string" &&
    Array.isArray((value as HistoryGroup).entries) &&
    (value as HistoryGroup).entries.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as HistoryEntry).virtualPath === "string" &&
        typeof (entry as HistoryEntry).snapshotId === "string",
    )
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

/**
 * Reads and parses `stack.json`. A genuinely missing file (never edited
 * yet, or a presentation opened for the first time under this id — see
 * AC 3's "reopening the same .comot starts with empty history") is an
 * empty stack; anything else — corrupt JSON, a malformed shape, a read
 * failure — is a loud CoMotionError, never a silent fallback to empty
 * (same stance as workspace.ts's readRegistry).
 */
async function readStack(home: string, id: string): Promise<StackFile> {
  let raw: string;
  try {
    raw = await readFile(stackPath(home, id), "utf-8");
  } catch (error) {
    if (isEnoent(error)) {
      return { undo: [], redo: [], openGroup: null };
    }
    throw new CoMotionError("復原歷史已損毀");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError("復原歷史已損毀");
  }
  if (!isStackFile(parsed)) {
    throw new CoMotionError("復原歷史已損毀");
  }
  return parsed;
}

/**
 * Atomic write: temp file + rename, the same pattern as workspace.ts's
 * writeRegistry. Every step — including the directory creation, which the
 * earlier version left outside the try block — is wrapped so a raw Node
 * I/O error (e.g. EACCES from a read-only history directory) can never
 * escape past this module with a real filesystem path in its message
 * (ADR-0004).
 */
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
    throw new CoMotionError("無法寫入復原歷史");
  }
}

/**
 * Writes one snapshot file. Wrapped end to end (directory creation and the
 * write itself) so a permission failure on `snapshots/` — the exact
 * reproduction that motivated this — surfaces as a CoMotionError instead of
 * a raw `EACCES: ... open '<real path>'` reaching the CLI's error printer.
 */
async function writeSnapshot(home: string, id: string, snapshotId: string, content: string): Promise<void> {
  const filePath = snapshotPath(home, id, snapshotId);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  } catch {
    throw new CoMotionError("無法寫入復原快照");
  }
}

async function readSnapshot(home: string, id: string, snapshotId: string): Promise<string> {
  try {
    return await readFile(snapshotPath(home, id, snapshotId), "utf-8");
  } catch {
    // stack.json still points at a snapshot file that is no longer there —
    // never skip the entry and pretend the group is smaller than it is.
    throw new CoMotionError("復原歷史已損毀");
  }
}

/**
 * Deletes one snapshot file. `force: true` only suppresses the file already
 * being gone (ENOENT) — any other failure (e.g. a permission error) is a
 * real problem and must not be swallowed (errors over fallbacks), so it is
 * wrapped into a CoMotionError rather than silently ignored.
 */
async function deleteSnapshot(home: string, id: string, snapshotId: string): Promise<void> {
  try {
    await rm(snapshotPath(home, id, snapshotId), { force: true });
  } catch {
    throw new CoMotionError("無法刪除復原快照");
  }
}

/** Pushes a group onto the undo stack, then enforces UNDO_STACK_CAP by evicting the oldest. */
async function pushGroupToUndoStack(
  home: string,
  id: string,
  stack: StackFile,
  group: HistoryGroup,
): Promise<void> {
  stack.undo.push(group);
  while (stack.undo.length > UNDO_STACK_CAP) {
    const evicted = stack.undo.shift()!;
    for (const entry of evicted.entries) {
      await deleteSnapshot(home, id, entry.snapshotId);
    }
  }
}

/**
 * Writes a snapshot file for each listed path's *current* content, taken
 * before the caller overwrites it — but does not touch the undo/redo
 * stacks yet. Split out from the old single-shot `recordSnapshot` so a
 * caller (`writePresentationFile`) can snapshot first, attempt its actual
 * content write, and only then decide whether to `commitSnapshotEntries`
 * (write succeeded) or `discardSnapshotEntries` (write failed) — so a
 * failed write never occupies an undo slot (ticket #73 finding 2).
 */
export async function stageSnapshotEntries(id: string, virtualPaths: string[]): Promise<HistoryEntry[]> {
  const home = resolveCoMotionHome();
  const workDir = await resolveWorkDir(id);
  const entries: HistoryEntry[] = [];
  for (const virtualPath of virtualPaths) {
    const content = await readVirtualFile(workDir, virtualPath);
    const snapshotId = generateOpaqueId();
    await writeSnapshot(home, id, snapshotId, content);
    entries.push({ virtualPath, snapshotId });
  }
  return entries;
}

/**
 * Commits previously staged entries onto the undo timeline: with an open
 * group (`beginHistoryGroup`), the entries are appended to it; otherwise
 * they become their own single-command undo group immediately. Every call
 * clears the redo stack — undo is a linear timeline, and a new edit after
 * an undo invalidates whatever redo would have replayed — and it *deletes*
 * every cleared redo entry's snapshot file rather than just dropping the
 * stack.json references to it, so an ordinary "set → undo → set" loop does
 * not leave the file on disk with nothing pointing at it (finding 1).
 */
export async function commitSnapshotEntries(id: string, entries: HistoryEntry[]): Promise<void> {
  const home = resolveCoMotionHome();
  const stack = await readStack(home, id);

  for (const group of stack.redo) {
    for (const entry of group.entries) {
      await deleteSnapshot(home, id, entry.snapshotId);
    }
  }
  stack.redo = [];

  if (stack.openGroup) {
    stack.openGroup.entries.push(...entries);
  } else {
    await pushGroupToUndoStack(home, id, stack, { groupId: generateOpaqueId(), entries });
  }
  await writeStack(home, id, stack);
}

/**
 * Deletes snapshot files staged by `stageSnapshotEntries` whose write was
 * never committed — the caller's actual content write failed, so these
 * would otherwise sit on disk unreferenced by any stack (finding 2).
 */
export async function discardSnapshotEntries(id: string, entries: HistoryEntry[]): Promise<void> {
  const home = resolveCoMotionHome();
  for (const entry of entries) {
    await deleteSnapshot(home, id, entry.snapshotId);
  }
}

/**
 * Registers a snapshot of each listed file's current content and commits it
 * onto the undo timeline immediately — `stageSnapshotEntries` followed by
 * `commitSnapshotEntries`. Kept as the simple, single-call entry point for
 * a caller that has no failure-before-commit case of its own to guard
 * against.
 */
export async function recordSnapshot(id: string, virtualPaths: string[]): Promise<void> {
  const entries = await stageSnapshotEntries(id, virtualPaths);
  await commitSnapshotEntries(id, entries);
}

/**
 * Opens a group that spans multiple commands (an agent's turn, AC 2) so
 * they undo together as one step. Nests are refused rather than reference
 * counted (no known need for it). The caller MUST call `endHistoryGroup` in
 * a `finally` block — a group left open by a crash or an early return stays
 * open forever and silently absorbs the next command's snapshot into it.
 * Wiring this to the server's actual turn lifecycle is out of scope for
 * this unit (see #91, "凍結").
 */
export async function beginHistoryGroup(id: string): Promise<void> {
  const home = resolveCoMotionHome();
  await resolveWorkDir(id);
  const stack = await readStack(home, id);
  if (stack.openGroup) {
    throw new CoMotionError("已經有開啟中的復原群組");
  }
  stack.openGroup = { groupId: generateOpaqueId(), entries: [] };
  await writeStack(home, id, stack);
}

/**
 * Closes the group opened by `beginHistoryGroup` and pushes it onto the
 * undo stack as one step. An empty group (no command in it ever wrote
 * anything) is discarded rather than pushed, so an undo never lands on a
 * step that visibly does nothing. See `beginHistoryGroup` for the `finally`
 * requirement this function's caller must honour.
 */
export async function endHistoryGroup(id: string): Promise<void> {
  const home = resolveCoMotionHome();
  await resolveWorkDir(id);
  const stack = await readStack(home, id);
  const group = stack.openGroup;
  if (!group) {
    throw new CoMotionError("沒有開啟中的復原群組");
  }
  stack.openGroup = null;
  if (group.entries.length > 0) {
    await pushGroupToUndoStack(home, id, stack, group);
  }
  await writeStack(home, id, stack);
}

/**
 * Applies one group's snapshots to disk and returns the group that would
 * undo this application (used by both undo and redo — they are the same
 * operation run against opposite stacks).
 *
 * Every entry's *current* content is captured first, before any entry is
 * applied. This matters when the same virtualPath appears more than once
 * in a group (an element edited twice in one agent turn): capturing before
 * any write means every entry for that path captures the same, correct
 * "current" value, regardless of the order entries are processed in.
 *
 * Entries are then applied last-to-first. A group's entries were recorded
 * in the order their edits happened, each one holding the content from
 * *before* that edit — applying them in reverse peels the edits off like a
 * stack, so a path touched twice ends up at the state before its first
 * edit, not the state before its second.
 */
async function applyGroup(
  home: string,
  id: string,
  workDir: string,
  group: HistoryGroup,
): Promise<{ inverseGroup: HistoryGroup; restoredPaths: string[] }> {
  const inverseEntries: HistoryEntry[] = [];
  for (const entry of group.entries) {
    const currentContent = await readVirtualFile(workDir, entry.virtualPath);
    const inverseSnapshotId = generateOpaqueId();
    await writeSnapshot(home, id, inverseSnapshotId, currentContent);
    inverseEntries.push({ virtualPath: entry.virtualPath, snapshotId: inverseSnapshotId });
  }

  for (let i = group.entries.length - 1; i >= 0; i--) {
    const entry = group.entries[i];
    const content = await readSnapshot(home, id, entry.snapshotId);
    const realPath = await resolveVirtualFilePath(workDir, entry.virtualPath);
    try {
      await writeFile(realPath, content, "utf-8");
    } catch {
      throw new CoMotionError(`寫入投影片時發生錯誤：${entry.virtualPath}`);
    }
    await deleteSnapshot(home, id, entry.snapshotId);
  }

  const restoredPaths = [...new Set(group.entries.map((entry) => entry.virtualPath))];
  return { inverseGroup: { groupId: group.groupId, entries: inverseEntries }, restoredPaths };
}

/** Undoes the most recent group, moving it onto the redo stack. */
export async function undoLastGroup(id: string): Promise<{ restoredPaths: string[] }> {
  const home = resolveCoMotionHome();
  const workDir = await resolveWorkDir(id);
  const stack = await readStack(home, id);
  const group = stack.undo.pop();
  if (!group) {
    throw new CoMotionError("沒有可復原的操作");
  }
  const { inverseGroup, restoredPaths } = await applyGroup(home, id, workDir, group);
  stack.redo.push(inverseGroup);
  await writeStack(home, id, stack);
  return { restoredPaths };
}

/**
 * Redoes the most recently undone group, moving it back onto the undo
 * stack (subject to the same UNDO_STACK_CAP as any other push). The
 * content redone is whatever was on disk at the moment of that undo call
 * (ruling: "redo captures its 'after' state at undo time"), not a second
 * independently-tracked "future" — so a change made outside undo/redo
 * between the undo and the redo (e.g. someone editing the work directory
 * directly) is what redo brings back.
 */
export async function redoLastGroup(id: string): Promise<{ restoredPaths: string[] }> {
  const home = resolveCoMotionHome();
  const workDir = await resolveWorkDir(id);
  const stack = await readStack(home, id);
  const group = stack.redo.pop();
  if (!group) {
    throw new CoMotionError("沒有可重做的操作");
  }
  const { inverseGroup, restoredPaths } = await applyGroup(home, id, workDir, group);
  await pushGroupToUndoStack(home, id, stack, inverseGroup);
  await writeStack(home, id, stack);
  return { restoredPaths };
}
