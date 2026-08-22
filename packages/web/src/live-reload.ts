/**
 * Live reload (ticket #5): opens a one-way `/api/events` stream and calls
 * `onChange` whenever the server reports the presentation changed on disk.
 * Push is server-to-client only — this module never writes back over the
 * stream, and the event carries no payload, so `onChange` is the caller's
 * cue to re-fetch full state (via the canvas controller's `reload()`),
 * never a diff to apply.
 *
 * `openEventStream` implements no replay by design (see its own comment
 * and watch.ts's), so any edit that lands while no stream is connected is
 * otherwise invisible forever. `EventSource` reconnects automatically
 * after any network interruption — that is the normal case, not an
 * exotic one — so every successful connection, the first one and every
 * reconnect, is treated as "something might have been missed" and
 * triggers the same full reload a live `presentation-changed` event
 * would. This is why `onChange` fires on the stream's `open` event too,
 * not only on `presentation-changed`.
 *
 * jsdom (the web package's test environment) has no `EventSource`
 * constructor, so it is injectable rather than read off `window` directly
 * — tests drive a fake constructor, they do not stub a global.
 */
export interface LiveReload {
  stop(): void;
}

const CHANGE_EVENT = "presentation-changed";
const EVENTS_PATH = "/api/events";

export function startLiveReload(options: {
  onChange: () => void;
  eventSourceFactory?: (url: string) => EventSource;
}): LiveReload {
  const createEventSource = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  const source = createEventSource(EVENTS_PATH);

  // Every successful (re)connection may have missed an edit — reload
  // unconditionally rather than only when a change event happens to
  // arrive after reconnecting.
  source.addEventListener("open", () => {
    options.onChange();
  });

  source.addEventListener(CHANGE_EVENT, () => {
    options.onChange();
  });

  return {
    stop(): void {
      source.close();
    },
  };
}
