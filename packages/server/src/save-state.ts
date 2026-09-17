// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, constants } from "node:fs/promises";
import path from "node:path";
import { readProjectsRegistry } from "./slidra/home.js";
import { readSaveState } from "./slidra/save-state.js";
import { runJsonCommand } from "./slidra/command.js";
import type { ChangeBroadcaster } from "./changes.js";
import type { EditingLock } from "./editing-lock.js";

/** NOOP-422: adds `phase`/`reason` to `slidra/save-state.ts`'s `SaveState` — the wire shape `GET /api/save-state` and the `save-state` SSE event both carry. */
export type SavePhase = "saved" | "saving" | "failed";
export type SaveStateWire =
  | { known: false }
  | { known: true; dirty: boolean; fileName: string; phase: SavePhase; reason?: string };

/** Trailing debounce after the most recent write. */
const DEFAULT_DEBOUNCE_MS = 800;
/** Hard cap on how long a continuous burst of edits can delay a write-back. */
const DEFAULT_MAX_WAIT_MS = 5000;
/** How long to wait before retrying a debounce tick that found the editing floor held. */
const LOCK_BUSY_RETRY_MS = 200;

/** `<file>`-scoped reason strings for a failed write-back, keyed by the Node `fs` errno that caused it. Never includes a real filesystem path — only `path.basename` — per ADR-0003. */
const REASON_BY_CODE: Record<string, (file: string) => string> = {
  ENOENT: (file) => `The folder holding ${file} is no longer available — it may have been unplugged or unmounted.`,
  EACCES: (file) => `Permission denied writing ${file}.`,
  EPERM: (file) => `Permission denied writing ${file}.`,
  EROFS: (file) => `${file} is on a read-only volume.`,
  ENOSPC: (file) => `No space left on the disk holding ${file}.`,
  EBUSY: (file) => `${file} is locked by another program.`,
  ETXTBSY: (file) => `${file} is locked by another program.`,
};

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/**
 * Turns a write-back failure into a `reason` safe to put on the wire.
 * Deliberately never relays `error.message` (a Node `fs` error or a
 * `pack` failure message can both carry a real absolute path, ADR-0003) —
 * only `path.basename(sourcePath)` plus a fixed sentence keyed off the
 * errno, when one is available.
 */
function classifyFailure(error: unknown, fileName: string): string {
  const code = errnoCode(error);
  const known = code !== undefined ? REASON_BY_CODE[code] : undefined;
  if (known) return known(fileName);
  return `Could not write ${fileName} (${code ?? "unknown"}).`;
}

export interface SaveController {
  /** Called on every successful human write route (`/api/command`, `/api/asset`, `/api/undo`, `/api/redo`) and on every `editingLock` `unfrozen` (an agent turn just released the floor). Schedules (or reschedules) the trailing debounce. A no-op with no deck bound. */
  markDirty(): void;
  /** Cancels any pending debounce timer and writes back immediately. Resolves to the resulting state either way (including a `failed` one). */
  flush(): Promise<SaveStateWire>;
  /** The current state, combining this controller's own in-memory pending flag with `readSaveState`'s on-disk mtime comparison — the on-disk side alone is what catches a dirty deck left behind by a previous crash. */
  state(): Promise<SaveStateWire>;
  /**
   * Re-points this controller at `id`. Switching to a genuinely different id
   * flushes whatever is pending on the outgoing one first (never abandons an
   * unwritten edit just because the deck changed underneath it); re-pointing
   * at the SAME id (an in-place `/api/open`/`/api/new` reopen) instead just
   * discards any pending state for the content that no longer exists —
   * flushing it would overwrite the freshly-opened file with stale bytes.
   * Either way, once pointed at `id`, checks whether the deck is already
   * dirty on disk (a save left unfinished across a restart) and schedules a
   * write-back if so.
   */
  retarget(id: string | null): Promise<void>;
  /** Cancels any pending timer and, if a write is still owed, writes it back — the server-shutdown path's "don't lose the last debounce window" guarantee. */
  dispose(): Promise<void>;
}

export interface SaveControllerOptions {
  presentationId: string | null;
  broadcaster: ChangeBroadcaster;
  editingLock: EditingLock;
  debounceMs?: number;
  maxWaitMs?: number;
}

/**
 * NOOP-422 (Continuous save): owns the debounced write-back that replaced
 * the manual Save button. `markDirty()` is the only thing routes/the
 * editing lock call during normal operation; `flush()` backs the Retry
 * button, the unsaved-changes modal's "Save now", and
 * `applyTemplateToSlides`'s pre-dispatch save.
 */
export function createSaveController(options: SaveControllerOptions): SaveController {
  const { broadcaster, editingLock } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  let presentationId = options.presentationId;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstDirtyAt: number | undefined;
  /** True while an edit exists that has not yet been durably written back — independent of `phase`, which only describes the *last attempt's* outcome. */
  let pending = false;
  let phase: SavePhase = "saved";
  let reason: string | undefined;

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function armTimer(delayMs: number): void {
    cancelTimer();
    timer = setTimeout(() => void tick(), delayMs);
    // Never keeps the process alive on its own — same reasoning as
    // editing-lock.ts's own lease timer and watch.ts's debounce.
    timer.unref?.();
  }

  function tick(): void {
    timer = undefined;
    if (!pending || presentationId === null) return;
    if (editingLock.getState() !== "idle") {
      // Never steals the floor from a live drag or an agent turn — wait and
      // re-check, without touching `firstDirtyAt` (the max-wait clock keeps
      // running against the real first-dirty moment).
      armTimer(LOCK_BUSY_RETRY_MS);
      return;
    }
    editingLock.beginHumanEdit();
    void performSave()
      .then((wire) => broadcaster.broadcast("save-state", wire))
      .finally(() => editingLock.endHumanEdit());
  }

  /** Combines the in-memory `pending`/`phase` bookkeeping with the on-disk mtime comparison (`readSaveState`) — the latter is what surfaces a deck left dirty by a crash this process never saw happen. */
  async function computeState(): Promise<SaveStateWire> {
    if (presentationId === null) return { known: false };
    let onDisk: Awaited<ReturnType<typeof readSaveState>>;
    try {
      onDisk = await readSaveState(presentationId);
    } catch {
      return { known: false };
    }
    if (!onDisk.known) return { known: false };
    const dirty = pending || onDisk.dirty;
    if (!dirty) return { known: true, dirty: false, fileName: onDisk.fileName, phase: "saved" };
    if (phase === "failed") {
      return { known: true, dirty: true, fileName: onDisk.fileName, phase: "failed", reason };
    }
    return { known: true, dirty: true, fileName: onDisk.fileName, phase: "saving" };
  }

  /**
   * The actual write-back: a writability probe (so a foreseeable failure
   * never even reaches `pack`) followed by `pack <id> <sourcePath>`. Never
   * throws — every outcome is folded into `phase`/`reason` and returned as
   * a `SaveStateWire`. Deliberately does NOT broadcast — callers that want
   * the result on the wire do that themselves, so `retarget`'s "flush the
   * OUTGOING deck before switching" can write it back silently without
   * jumping ahead of `POST /api/deck/switch`'s own fixed
   * deck-changed/presentation-changed/save-state broadcast order
   * (NOOP-433 §3) with an event about a deck nothing is listening for
   * updates on any more.
   */
  async function performSave(): Promise<SaveStateWire> {
    const id = presentationId;
    if (id === null) return { known: false };

    const registry = await readProjectsRegistry();
    const entry = registry.get(id);
    if (!entry || entry.sourcePath === undefined) {
      // Nothing to write back to yet (e.g. a legacy registry entry) —
      // never an error, never scheduled again until the next markDirty().
      pending = false;
      firstDirtyAt = undefined;
      phase = "saved";
      reason = undefined;
      return computeState();
    }

    const { deckPath, sourcePath } = entry;
    const fileName = path.basename(sourcePath);
    try {
      await access(deckPath, constants.W_OK);
      await access(path.dirname(deckPath), constants.W_OK);
      if (sourcePath !== deckPath) {
        await access(path.dirname(sourcePath), constants.W_OK);
      }
      const result = await runJsonCommand(["pack", id, sourcePath]);
      if (!result.ok) {
        throw new Error(result.message);
      }
      pending = false;
      firstDirtyAt = undefined;
      phase = "saved";
      reason = undefined;
    } catch (error) {
      // `pending` stays true — the edit is still unwritten and owed a retry
      // (the Retry button, or the next markDirty(), calls flush()/tick() again).
      phase = "failed";
      reason = classifyFailure(error, fileName);
    }

    return computeState();
  }

  function markDirty(): void {
    if (presentationId === null) return;
    pending = true;
    if (firstDirtyAt === undefined) firstDirtyAt = Date.now();
    const elapsed = Date.now() - firstDirtyAt;
    const delay = Math.min(debounceMs, Math.max(0, maxWaitMs - elapsed));
    armTimer(delay);
  }

  async function flush(): Promise<SaveStateWire> {
    cancelTimer();
    if (presentationId === null) return { known: false };
    if (!pending) return computeState();
    try {
      editingLock.beginHumanEdit();
    } catch {
      // The agent holds the floor right now (a route-level 409 normally
      // prevents this call from ever reaching here) — leave `pending` as it
      // is and report the current state; the caller can retry.
      return computeState();
    }
    let wire: SaveStateWire;
    try {
      wire = await performSave();
    } finally {
      editingLock.endHumanEdit();
    }
    broadcaster.broadcast("save-state", wire);
    return wire;
  }

  async function resumeIfDirty(id: string): Promise<void> {
    let onDisk: Awaited<ReturnType<typeof readSaveState>>;
    try {
      onDisk = await readSaveState(id);
    } catch {
      return;
    }
    if (onDisk.known && onDisk.dirty) {
      // A deck left dirty by an earlier crash/restart — schedule a
      // write-back the same way a live edit would, rather than waiting for
      // the next actual edit to notice.
      markDirty();
    }
  }

  async function retarget(id: string | null): Promise<void> {
    const switchingToDifferentId = id !== presentationId;
    if (switchingToDifferentId && pending && presentationId !== null) {
      // Writes the OUTGOING deck back silently — `deckSession`'s `switchTo`
      // (deck-switch.ts) only ever calls `bind` (which is what calls this)
      // with the editing floor idle and no other switch in flight, so there
      // is nothing else to race here. Never broadcasts: the caller
      // (`POST /api/deck/switch`) has its own fixed
      // deck-changed/presentation-changed/save-state order to preserve, and
      // this state is about a deck the stream is no longer even scoped to.
      cancelTimer();
      await performSave();
    }
    cancelTimer();
    presentationId = id;
    pending = false;
    firstDirtyAt = undefined;
    phase = "saved";
    reason = undefined;
    if (id !== null) {
      await resumeIfDirty(id);
    }
  }

  async function dispose(): Promise<void> {
    cancelTimer();
    if (pending) {
      await flush();
    }
  }

  if (presentationId !== null) {
    // Startup never goes through `retarget` (see its own docstring on
    // `serve.ts`'s bind/unbind convention) — resolve the initial
    // "left dirty by a crash" check here instead.
    void resumeIfDirty(presentationId);
  }

  return { markDirty, flush, state: computeState, retarget, dispose };
}

/** Broadcasts `controller`'s current state as the `save-state` SSE event — the same one shared `/api/events` stream (§3.3/§4.2) every other broadcast already uses. */
export async function broadcastSaveState(broadcaster: ChangeBroadcaster, controller: SaveController): Promise<void> {
  broadcaster.broadcast("save-state", await controller.state());
}
