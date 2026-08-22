import { watch as fsWatch } from "node:fs";
import { CoMotionError } from "./errors.js";
import { resolveWorkDir } from "./workspace.js";

/**
 * Watches one presentation's work directory for filesystem changes and
 * calls `onChange` (debounced, coalesced) whenever something changes.
 *
 * `onChange` deliberately carries no payload — not which file, not what
 * changed. `openEventStream` (packages/server/src/sse.ts) implements no
 * event replay, so a reconnecting client must recover by re-reading full
 * state; an event that carried a diff would be unusable after a missed
 * one. Callers are expected to re-read presentation state through the
 * existing read path (`readPresentationFile` / `listPresentationEntries`)
 * whenever `onChange` fires.
 *
 * Watching lives here, not in `packages/server`, because the caller must
 * never learn the presentation's real work directory (ADR-0004, third
 * layer) — this module is the only place that resolves the opaque id to a
 * real path, exactly like `readPresentationFile` above.
 */
export interface PresentationWatcher {
  close(): Promise<void>;
}

// Trailing debounce window: a single logical edit (e.g. `text set`) can
// produce more than one raw filesystem event, and this coalesces them into
// one `onChange` call without swallowing distinct, separately-timed edits.
const DEBOUNCE_MS = 100;

/**
 * Starts watching the presentation identified by `id`. Resolves only after
 * the id has been confirmed to exist, so a caller awaiting this gets the
 * same explicit unknown-id failure `readPresentationFile` would — both go
 * through `workspace.ts`'s `resolveWorkDir`, the one id-to-path lookup in
 * the codebase (ticket #5 fix round: this module used to keep its own
 * private copy of that lookup, which quietly regressed to reporting every
 * registry failure — a corrupt entry, an unreadable file — as "this
 * presentation does not exist"; ticket #11 fixed that distinction in
 * `workspace.ts` and this module now inherits it instead of drifting away
 * from it again).
 *
 * `onError` is called at most once if the underlying `fs.watch` handle
 * itself fails after startup (its target vanished, an OS watch limit was
 * hit, ...) — a condition live reload can never recover from on its own,
 * since no future filesystem change will ever be observed again. The
 * watcher closes itself first, so it stops looking like a live watcher
 * before the caller is even told; no further `onChange` call can follow.
 *
 * Required, not optional: there is exactly one production caller
 * (packages/server's SSE broadcaster, see changes.ts) and it must always
 * be able to inform the author in-band when the watcher dies. Making this
 * parameter optional would let a caller compile while silently forgetting
 * to handle that failure — the previous "throw and kill the process if
 * omitted" fallback existed only to cover that gap, and traded a loud
 * crash for the risk of an author never being told at all. A required
 * parameter makes that gap unrepresentable instead of merely documented.
 */
export async function watchPresentation(
  id: string,
  onChange: () => void,
  onError: (error: Error) => void,
): Promise<PresentationWatcher> {
  const workDir = await resolveWorkDir(id);

  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const scheduleNotify = (): void => {
    if (closed) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange();
    }, DEBOUNCE_MS);
    // Must be unref'd: a live setTimeout keeps the Node event loop alive,
    // which would hang the test suite and stop `co-motion serve` from ever
    // exiting on Ctrl-C (the same trap the SSE heartbeat timer hit).
    debounceTimer.unref();
  };

  let watcher: ReturnType<typeof fsWatch>;
  try {
    watcher = fsWatch(workDir, { recursive: true }, () => {
      scheduleNotify();
    });
  } catch {
    // `fs.watch` throws synchronously (not just via its `error` event) when
    // the target has vanished or become unreadable between id resolution
    // above and this call — e.g. the work directory was removed after
    // server startup but before the first `/api/events` connection. That
    // raw error's message very likely embeds the real work directory path
    // (ADR-0004), exactly like the asynchronous `error` event handled
    // below, so it gets the same sanitised treatment rather than being
    // allowed to propagate to the caller unmodified.
    throw new CoMotionError("監看簡報檔案時發生錯誤");
  }

  watcher.on("error", () => {
    if (closed) return;
    // Stop first: no further `onChange` must ever fire from a watcher that
    // has already failed — a died watcher must never look like a working
    // one, whether or not anything is listening for `onError`.
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher.close();
    // The underlying error object very likely embeds the real work
    // directory path (ADR-0004) — it is never logged or rethrown verbatim.
    onError(new CoMotionError("監看簡報檔案時發生錯誤"));
  });

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher.close();
    },
  };
}
