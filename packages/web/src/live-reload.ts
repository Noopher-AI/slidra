/**
 * Live reload (ticket #5): opens a one-way `/api/events` stream and calls
 * `onChange` whenever the server reports the presentation changed on disk.
 * Push is server-to-client only — this module never writes back over the
 * stream, and the event carries no payload, so `onChange` is the caller's
 * cue to re-fetch full state (via the canvas controller's `reload()`),
 * never a diff to apply.
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

  source.addEventListener(CHANGE_EVENT, () => {
    options.onChange();
  });

  return {
    stop(): void {
      source.close();
    },
  };
}
