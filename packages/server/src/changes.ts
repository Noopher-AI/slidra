import type { ServerResponse } from "node:http";
import { watchPresentation } from "@co-motion/core";
import type { PresentationWatcher } from "@co-motion/core";
import { openEventStream } from "./sse.js";
import type { EventStream } from "./sse.js";

/**
 * Live-reload push: fans out one `presentation-changed` SSE event to every
 * currently connected browser tab whenever the watched presentation's files
 * change on disk. The event carries no payload (`{}`) — the client re-reads
 * full state on every notification (see watch.ts's comment on why), and
 * `openEventStream` implements no replay, so a reconnecting client must be
 * able to recover the same way anyway.
 */
const CHANGE_EVENT = "presentation-changed";

export interface ChangeBroadcaster {
  /**
   * Opens one SSE stream on `res` and registers it to receive future change
   * events. Starts the underlying watcher lazily, on the first connection
   * only — a server that nobody ever opens a browser tab against never
   * pays for a watcher at all. Rejects (without writing anything to `res`)
   * if the watcher itself fails to start, e.g. an id unknown to the
   * watch-side registry lookup; the caller (serve.ts's request handler)
   * turns that into an explicit HTTP error response.
   */
  handleConnection(res: ServerResponse): Promise<void>;
  /** Stops watching (if ever started) and closes every currently open stream. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Builds a handle to fan `presentation-changed` events out to every SSE
 * connection for one presentation. More than one tab can be connected at
 * once; a closed stream is dropped from the fan-out set lazily (on the
 * next change) rather than needing its own disconnect wiring —
 * `EventStream.send` is already a no-op on a closed stream, so `closed` is
 * just used to stop tracking it.
 */
export function createChangeBroadcaster(presentationId: string): ChangeBroadcaster {
  const streams = new Set<EventStream>();
  let watcherPromise: Promise<PresentationWatcher> | null = null;

  function ensureWatcher(): Promise<PresentationWatcher> {
    if (!watcherPromise) {
      watcherPromise = watchPresentation(presentationId, () => {
        for (const stream of streams) {
          if (stream.closed) {
            streams.delete(stream);
            continue;
          }
          stream.send(CHANGE_EVENT, {});
        }
      });
    }
    return watcherPromise;
  }

  return {
    handleConnection: async (res: ServerResponse): Promise<void> => {
      await ensureWatcher();
      const stream = openEventStream(res);
      streams.add(stream);
    },

    dispose: async () => {
      // Every live stream must be closed before the HTTP server's socket
      // closes: server.close() waits for established connections rather
      // than severing them, and an open SSE stream never ends on its own.
      for (const stream of streams) {
        stream.close();
      }
      streams.clear();
      if (watcherPromise) {
        // If the watcher never successfully started (e.g. an id unknown to
        // the watch-side registry lookup), that failure was already
        // reported to whichever /api/events request triggered it — there
        // is nothing here to close, and re-throwing the same failure a
        // second time during shutdown would only make close() itself
        // reject instead of tearing resources down promptly.
        const watcher = await watcherPromise.catch(() => null);
        await watcher?.close();
      }
    },
  };
}
