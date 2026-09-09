import { readSaveState } from "./comotion/save-state.js";
import type { ChangeBroadcaster } from "./changes.js";

/**
 * Recomputes NOOP-93's save state and broadcasts it as the `save-state`
 * event over the one shared `/api/events` stream (§3.3/§4.2) — the same
 * `ChangeBroadcaster.broadcast` T5's `editing-frozen`/`editing-unfrozen`
 * already uses, never a second SSE stream.
 */
export async function broadcastSaveState(broadcaster: ChangeBroadcaster, presentationId: string): Promise<void> {
  const state = await readSaveState(presentationId);
  broadcaster.broadcast("save-state", state);
}
