import type { SaveState } from "@co-motion/core";

/**
 * NOOP-93 §4.4 — restated here rather than imported: `@co-motion/server`'s
 * `export/job.ts` owns the canonical shape, but it is a Node-only package
 * (Playwright, `node:*`) the browser bundle must never depend on. Same
 * pattern `presentation.ts`'s `TemplateInfo` already uses for core's
 * `TemplateEntry`.
 */
export type ExportFormat = "pdf" | "pdf-frames";
export type ExportSseEvent =
  | { jobId: string; format: ExportFormat; state: "queued" }
  | { jobId: string; format: ExportFormat; state: "running"; totalFrames: number; completedFrames: number }
  | { jobId: string; format: ExportFormat; state: "progress"; totalFrames: number; completedFrames: number }
  | {
      jobId: string;
      format: ExportFormat;
      state: "done";
      totalFrames: number;
      completedFrames: number;
      pageCount: number;
      fileName: string;
      downloadPath: string;
    }
  | { jobId: string; format: ExportFormat; state: "error"; message: string };

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
// Pushed once, to every currently connected tab, if the server's watcher
// itself dies (see packages/server/src/changes.ts's WATCH_ERROR_EVENT).
// Without a listener for this specific event, the author never learns why
// the canvas stopped updating: the stream closes, EventSource reconnects on
// its own, gets an explicit HTTP error back, and silently keeps trying
// forever with nothing on screen.
const WATCH_ERROR_EVENT = "presentation-watch-error";
// T5 (NOOP-93/#110): the single-editor lock's own two events, fanned out
// over this same /api/events stream rather than a second one (see
// packages/server/src/changes.ts's `broadcast`).
const EDITING_FROZEN_EVENT = "editing-frozen";
const EDITING_UNFROZEN_EVENT = "editing-unfrozen";
// NOOP-93 §4.2: fanned out over this same stream by `POST /api/save` and
// `POST /api/open` — never by the generic disk watcher that feeds
// `presentation-changed` (changes.ts stays untouched, see save-state.ts's
// own comment). An ordinary edit (e.g. via /api/command) is instead picked
// up by the caller reacting to `onChange` and re-fetching `/api/save-state`
// itself, the same GET-refetch shape `onChange` already uses for
// `/api/presentation`.
const SAVE_STATE_EVENT = "save-state";
// NOOP-93 §4.4: every state transition of the (at most one) active export
// job, fanned out over this same stream. No GET counterpart exists for
// this one (§4.7's table, "重新整理頁面後" row) — a reload deliberately
// loses in-flight job UI state, so there is nothing to seed on mount.
const EXPORT_EVENT = "export";
const EVENTS_PATH = "/api/events";
const DEFAULT_ERROR_MESSAGE = "即時預覽已中斷";

// The numeric value of the standard `EventSource.CLOSED` readyState (2).
// Read as a plain number, not the `EventSource` global's static constant,
// so this also works against the fake `EventSource` jsdom test doubles
// inject (jsdom itself has no `EventSource` constructor to read the
// constant off).
const READY_STATE_CLOSED = 2;

export function startLiveReload(options: {
  onChange: () => void;
  /**
   * Called at most once, with a Traditional-Chinese message meant to be
   * shown directly in the UI, once live reload can no longer recover on
   * its own: either the server told us the watcher died
   * (`presentation-watch-error`), or the connection failed permanently
   * (`EventSource`'s own `error` event with `readyState` gone to
   * `CLOSED` — no further automatic reconnect will happen). A transient
   * `error` while `EventSource` is still retrying is not reported here;
   * that is the normal reconnect path `onChange`'s `open` handling already
   * covers.
   */
  onError?: (message: string) => void;
  /**
   * T5 (NOOP-93/#110): fired whenever the server reports the single-editor
   * lock changing (`true` on `editing-frozen`, `false` on
   * `editing-unfrozen`). Like `onChange`, this stream carries no replay —
   * the initial state on load/reconnect must come from `GET /api/editing`,
   * called by the caller, not from this stream.
   */
  onFrozenChange?: (frozen: boolean) => void;
  /**
   * NOOP-93 §4.2: fired with the freshly-recomputed save state whenever the
   * server broadcasts one (after `POST /api/save` or `POST /api/open`
   * succeeds). Like `onFrozenChange`, the initial value on load/reconnect
   * must come from a `GET /api/save-state` the caller makes itself — this
   * stream carries no replay.
   */
  onSaveStateChange?: (state: SaveState) => void;
  /** NOOP-93 §4.4: fired for every `export` SSE event — queued/running/progress/done/error, in that legal order, for at most one active job at a time. */
  onExportEvent?: (event: ExportSseEvent) => void;
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

  source.addEventListener(EDITING_FROZEN_EVENT, () => {
    options.onFrozenChange?.(true);
  });

  source.addEventListener(EDITING_UNFROZEN_EVENT, () => {
    options.onFrozenChange?.(false);
  });

  source.addEventListener(SAVE_STATE_EVENT, (event) => {
    const state = parseSaveStateEventData(event);
    if (state) options.onSaveStateChange?.(state);
  });

  source.addEventListener(EXPORT_EVENT, (event) => {
    const parsed = parseExportEventData(event);
    if (parsed) options.onExportEvent?.(parsed);
  });

  source.addEventListener(WATCH_ERROR_EVENT, (event) => {
    const message = parseWatchErrorMessage(event) ?? DEFAULT_ERROR_MESSAGE;
    options.onError?.(message);
    // The server already closed its end and will refuse every later
    // connection (see changes.ts's `fatalError`) — retrying forever would
    // just accumulate silent, doomed reconnect attempts.
    source.close();
  });

  source.addEventListener("error", () => {
    // A plain `error` while `EventSource` is still going to retry
    // (readyState CONNECTING) is the ordinary reconnect path, already
    // handled by `open`'s unconditional reload above — not something to
    // surface as a failure. Only `CLOSED` means the browser itself has
    // given up and nothing will bring this stream back without user
    // action.
    if (source.readyState === READY_STATE_CLOSED) {
      options.onError?.(DEFAULT_ERROR_MESSAGE);
    }
  });

  return {
    stop(): void {
      source.close();
    },
  };
}

function parseWatchErrorMessage(event: Event): string | undefined {
  const data = (event as MessageEvent).data;
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a `save-state` SSE payload — same shape `GET /api/save-state` returns. An unparseable/malformed payload is dropped rather than fabricating a state (errors over fallbacks). */
function parseSaveStateEventData(event: Event): SaveState | undefined {
  const data = (event as MessageEvent).data;
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("known" in parsed)) return undefined;
  const known = (parsed as { known: unknown }).known;
  if (known === false) return { known: false };
  if (known !== true) return undefined;
  const { dirty, fileName } = parsed as { dirty?: unknown; fileName?: unknown };
  if (typeof dirty !== "boolean" || typeof fileName !== "string") return undefined;
  return { known: true, dirty, fileName };
}

/** Parses an `export` SSE payload — same shape `export/job.ts`'s `ExportEvent` sends. An unparseable/malformed payload (or an unrecognised `state`) is dropped, never fabricated (errors over fallbacks). */
function parseExportEventData(event: Event): ExportSseEvent | undefined {
  const data = (event as MessageEvent).data;
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const { jobId, format, state } = record;
  if (typeof jobId !== "string") return undefined;
  if (format !== "pdf" && format !== "pdf-frames") return undefined;

  if (state === "queued") return { jobId, format, state };
  if (state === "running" || state === "progress") {
    const { totalFrames, completedFrames } = record;
    if (typeof totalFrames !== "number" || typeof completedFrames !== "number") return undefined;
    return { jobId, format, state, totalFrames, completedFrames };
  }
  if (state === "done") {
    const { totalFrames, completedFrames, pageCount, fileName, downloadPath } = record;
    if (
      typeof totalFrames !== "number" ||
      typeof completedFrames !== "number" ||
      typeof pageCount !== "number" ||
      typeof fileName !== "string" ||
      typeof downloadPath !== "string"
    ) {
      return undefined;
    }
    return { jobId, format, state, totalFrames, completedFrames, pageCount, fileName, downloadPath };
  }
  if (state === "error") {
    const { message } = record;
    if (typeof message !== "string") return undefined;
    return { jobId, format, state, message };
  }
  return undefined;
}
