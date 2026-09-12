import { watch as fsWatch } from "node:fs";
import { CoMotionError } from "./comotion/errors.js";
import { workDirFor } from "./comotion/home.js";

/**
 * Watches one presentation's work directory for filesystem changes and
 * calls `onChange` (debounced, coalesced) whenever something changes.
 * Ported verbatim from `packages/core`'s `watch.ts` ([E4.T9]/F7 — the
 * server no longer imports `packages/core` at all); the only change is
 * `resolveWorkDir` -> `workDirFor` (`comotion/home.ts`), which resolves
 * the same `projects.json` registry file.
 *
 * `onChange` deliberately carries no payload — not which file, not what
 * changed. `openEventStream` (packages/server/src/sse.ts) implements no
 * event replay, so a reconnecting client must recover by re-reading full
 * state; an event that carried a diff would be unusable after a missed
 * one. Callers are expected to re-read presentation state through the
 * existing read path whenever `onChange` fires.
 */
export interface PresentationWatcher {
  close(): Promise<void>;
}

/**
 * The CLI's per-presentation file lock (`.comotion.lock`, #303) lives
 * inside the watched work directory and is created and removed around
 * every command — reads included. It is coordination, never content, so a
 * change to it must not reach `onChange`: `serve` answers a live-reload
 * notification by re-reading the presentation *through the CLI*, which
 * takes the lock again, which notifies again — a loop that never settles.
 * Its visible symptom is the editor reloading constantly, which drops the
 * author's selection the instant they click an element.
 */
const LOCK_FILE_NAME = ".comotion.lock";

function isCoordinationFile(filename: string | Buffer | null): boolean {
  if (filename === null) return false;
  const name = typeof filename === "string" ? filename : filename.toString("utf-8");
  return name === LOCK_FILE_NAME || name.endsWith(`/${LOCK_FILE_NAME}`);
}

// Trailing debounce window: a single logical edit (e.g. `text set`) can
// produce more than one raw filesystem event, and this coalesces them into
// one `onChange` call without swallowing distinct, separately-timed edits.
const DEBOUNCE_MS = 100;

/**
 * Starts watching the presentation identified by `id`. Resolves only after
 * the id has been confirmed to exist, so a caller awaiting this gets the
 * same explicit unknown-id failure every other read would.
 *
 * `onError` is called at most once if the underlying `fs.watch` handle
 * itself fails after startup — a condition live reload can never recover
 * from on its own. The watcher closes itself first, so it stops looking
 * like a live watcher before the caller is even told; no further
 * `onChange` call can follow.
 */
export async function watchPresentation(
  id: string,
  onChange: () => void,
  onError: (error: Error) => void,
): Promise<PresentationWatcher> {
  const workDir = await workDirFor(id);

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
    // which would hang the test suite and stop `comotion serve` from ever
    // exiting on Ctrl-C.
    debounceTimer.unref();
  };

  let watcher: ReturnType<typeof fsWatch>;
  try {
    watcher = fsWatch(workDir, { recursive: true }, (_event, filename) => {
      if (isCoordinationFile(filename)) return;
      scheduleNotify();
    });
  } catch {
    // `fs.watch` throws synchronously (not just via its `error` event) when
    // the target has vanished or become unreadable between id resolution
    // above and this call. That raw error's message very likely embeds the
    // real work directory path (ADR-0004), exactly like the asynchronous
    // `error` event handled below, so it gets the same sanitised treatment.
    throw new CoMotionError("監看簡報檔案時發生錯誤");
  }

  watcher.on("error", () => {
    if (closed) return;
    // Stop first: no further `onChange` must ever fire from a watcher that
    // has already failed.
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
