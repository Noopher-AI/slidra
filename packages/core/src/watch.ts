import { readFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import { CoMotionError } from "./errors.js";
import { resolveCoMotionHome } from "./workspace.js";

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
 * Resolves `id` to its real work directory by re-reading the registry
 * directly. This intentionally duplicates `workspace.ts`'s private
 * `lookupWorkDir` (which is not exported, and `workspace.ts` is owned by
 * another unit this wave) rather than reaching into it — but it reuses the
 * exact same error wording an unknown id already produces elsewhere, so
 * callers see one consistent message rather than a second invented one.
 */
async function lookupWorkDir(id: string): Promise<string> {
  const home = resolveCoMotionHome();
  const registryPath = path.join(home, "projects.json");

  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch {
    throw new CoMotionError(`找不到識別碼對應的簡報：${id}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CoMotionError(`找不到識別碼對應的簡報：${id}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CoMotionError(`找不到識別碼對應的簡報：${id}`);
  }

  const entry = (parsed as Record<string, unknown>)[id];
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof (entry as { workDir?: unknown }).workDir !== "string"
  ) {
    throw new CoMotionError(`找不到識別碼對應的簡報：${id}`);
  }

  return (entry as { workDir: string }).workDir;
}

/**
 * Starts watching the presentation identified by `id`. Resolves only after
 * the id has been confirmed to exist, so a caller awaiting this gets the
 * same explicit unknown-id failure `readPresentationFile` would.
 */
export async function watchPresentation(id: string, onChange: () => void): Promise<PresentationWatcher> {
  const workDir = await lookupWorkDir(id);

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

  const watcher = fsWatch(workDir, { recursive: true }, () => {
    scheduleNotify();
  });

  watcher.on("error", () => {
    // The underlying error object very likely embeds the real work
    // directory path (ADR-0004) — it is never logged or rethrown verbatim.
    //
    // A watcher failure (its target directory vanished, the OS watch
    // descriptor limit was hit, ...) means live reload can never recover
    // on its own: no future filesystem change will ever be observed again,
    // silently. That is worse than a loud crash, so this is treated as
    // fatal rather than degraded-but-quiet — it surfaces as an uncaught
    // exception, which is this process's existing behaviour for a bug it
    // cannot recover from on its own.
    throw new CoMotionError("監看簡報檔案時發生錯誤");
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
