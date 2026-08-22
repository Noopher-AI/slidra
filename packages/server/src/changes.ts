import type { ServerResponse } from "node:http";
import { CoMotionError, watchPresentation } from "@co-motion/core";
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

/**
 * Sent once, to every currently connected tab, if the underlying watcher
 * itself dies (see watch.ts's `onError`). A dead watcher must never look
 * like a live one: this tells every connected client in-band, then those
 * streams are closed — never left open, silently receiving nothing ever
 * again.
 */
const WATCH_ERROR_EVENT = "presentation-watch-error";

export interface ChangeBroadcaster {
  /**
   * Opens one SSE stream on `res` and registers it to receive future change
   * events. Starts the underlying watcher lazily, on the first connection
   * only — a server that nobody ever opens a browser tab against never
   * pays for a watcher at all. Rejects (without writing anything to `res`)
   * if the watcher itself fails to start, e.g. an id unknown to the
   * watch-side registry lookup, if the watcher has since died, or if the
   * broadcaster has been disposed; the caller (serve.ts's request handler)
   * turns that into an explicit HTTP error response instead of leaving the
   * request open.
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
  // Set once dispose() has been called, and once more if the watcher dies
  // on its own. Checked both before and after every await in
  // handleConnection, so a connection that was already awaiting the lazy
  // watcher start when either happens is concluded rather than left open —
  // structurally, not by racing a flag set somewhere else.
  let disposed = false;
  let fatalError: Error | null = null;

  function ensureWatcher(): Promise<PresentationWatcher> {
    if (!watcherPromise) {
      watcherPromise = watchPresentation(
        presentationId,
        () => {
          for (const stream of streams) {
            if (stream.closed) {
              streams.delete(stream);
              continue;
            }
            stream.send(CHANGE_EVENT, {});
          }
        },
        (error) => {
          // The watcher will never observe another change. Tell every
          // currently connected tab, then close those streams — see
          // WATCH_ERROR_EVENT above — and remember the failure so any
          // later connection (including the browser's automatic
          // EventSource reconnect) gets an explicit error instead of a
          // stream that silently never updates again.
          fatalError = error;
          for (const stream of streams) {
            if (!stream.closed) {
              stream.send(WATCH_ERROR_EVENT, { message: error.message });
              stream.close();
            }
          }
          streams.clear();
        },
      );
    }
    return watcherPromise;
  }

  return {
    handleConnection: async (res: ServerResponse): Promise<void> => {
      if (disposed) {
        // Shutdown already started (ticket #5 fix 3): conclude the
        // request instead of opening a stream server.close() would then
        // wait on forever.
        throw new CoMotionError("伺服器正在關閉");
      }
      await ensureWatcher();
      if (disposed) {
        // dispose() ran while this connection was awaiting the lazy
        // watcher start — the exact race this fix closes. dispose() has
        // already seen no live streams and torn the watcher down; opening
        // one now would leave a stream server.close() waits on forever.
        throw new CoMotionError("伺服器正在關閉");
      }
      if (fatalError) {
        throw fatalError;
      }
      const stream = openEventStream(res);
      streams.add(stream);
    },

    dispose: async () => {
      disposed = true;
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
