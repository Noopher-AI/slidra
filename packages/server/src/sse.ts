import type { ServerResponse } from "node:http";

/**
 * A single open Server-Sent Events connection. Shared primitive for ticket
 * #5 (file-changed reload events) and ticket #6 (streamed agent replies) —
 * this module owns SSE framing so neither consumer reinvents it.
 */
export interface EventStream {
  /** True once the stream is finished, whether by close() or by the client disconnecting. */
  readonly closed: boolean;
  /**
   * Frames one event and hands it to the connection. Backpressure is this
   * primitive's own concern, deliberately not the caller's: `send` returns
   * nothing, so there is no signal a call site can forget to check. When
   * the socket stops accepting writes, frames wait in a bounded queue
   * (`MAX_QUEUED_BYTES`) until the client drains; a client that stays
   * behind past that cap has its stream closed rather than being buffered
   * further. Nothing is ever replayed — both consumers recover by
   * re-reading full state after a reconnect.
   */
  send(event: string, data: unknown): void;
  close(): void;
}

const DEFAULT_HEARTBEAT_MS = 15000;
// Node's timer implementation stores the delay in a 32-bit signed int and
// silently clamps anything above this to a 1ms interval instead of erroring
// (see Node's lib/internal/timers.js). A caller asking for a heartbeat
// beyond this would silently get a continuous write loop instead — so this
// is rejected too, not clamped away.
const MAX_HEARTBEAT_MS = 2147483647;

// How much framed-but-unwritten output one stream may hold while its client
// is behind. Reached only by a client that has effectively stopped draining
// the socket: 1 MiB is ~200 of ticket #6's 5KB reply chunks, far more than
// any momentary hiccup, and small enough that N stalled tabs cannot walk
// process memory upwards. Past it the stream is closed rather than grown —
// see EventStream.send.
const MAX_QUEUED_BYTES = 1024 * 1024;

/**
 * Writes SSE response headers on `res` and returns a handle to push events
 * over it. `res` must already be matched to the SSE route by the caller —
 * this function only frames the protocol, it does no routing.
 */
export function openEventStream(res: ServerResponse, options?: { heartbeatMs?: number }): EventStream {
  const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs > MAX_HEARTBEAT_MS) {
    // A caller-supplied bad interval is a programmer error, not a runtime
    // condition to clamp away — no "sensible default" is invented here.
    throw new TypeError(`heartbeatMs must be a positive integer, got: ${heartbeatMs}`);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Without this a client can sit waiting on a buffered response and the
  // stream appears dead even though events have already been queued.
  res.flushHeaders();

  let closed = false;
  // Frames `res.write()` has not accepted yet, held here rather than pushed
  // into Node's own unbounded write buffer, so the amount of outstanding
  // output has a ceiling this module controls.
  let queue: string[] = [];
  let queuedBytes = 0;
  let waitingForDrain = false;

  /** Shuts the stream down for good. Shared by close(), disconnect, overflow. */
  const finish = (endResponse: boolean): void => {
    closed = true;
    queue = [];
    queuedBytes = 0;
    clearInterval(heartbeat);
    res.removeListener("close", handleDisconnect);
    res.removeListener("drain", flushQueue);
    if (endResponse) res.end();
  };

  /**
   * Writes one already-framed string, reporting whether the socket will
   * take more. The `false` from `res.write()` — the value this ticket is
   * about — is what stops the flush loop instead of being discarded.
   */
  function writeFrame(frame: string): boolean {
    if (res.write(frame)) return true;
    waitingForDrain = true;
    res.once("drain", flushQueue);
    return false;
  }

  function flushQueue(): void {
    waitingForDrain = false;
    while (queue.length > 0) {
      const frame = queue.shift() as string;
      queuedBytes -= Buffer.byteLength(frame);
      if (!writeFrame(frame)) return;
    }
  }

  /** The single path every byte this module puts on the wire goes through. */
  function emit(frame: string): void {
    if (!waitingForDrain) {
      writeFrame(frame);
      return;
    }
    const size = Buffer.byteLength(frame);
    if (queuedBytes + size > MAX_QUEUED_BYTES) {
      // This client is too far behind to keep holding output for. It is
      // dropped, not buffered further and not replayed later: the
      // primitive has no history by design, and both consumers recover by
      // re-reading full state after reconnecting.
      finish(true);
      return;
    }
    queue.push(frame);
    queuedBytes += size;
  }

  const heartbeat = setInterval(() => {
    // A bare comment line: no event, no data, just keeps the connection
    // (and any intermediary proxy) from timing it out. Goes through the
    // same path as events — a heartbeat must not be the one write that
    // sneaks past the buffer ceiling.
    emit(": \n\n");
  }, heartbeatMs);
  // Must be unref'd: a live setInterval keeps the Node event loop alive,
  // which would hang the test suite and stop `slidra serve` from ever
  // exiting on Ctrl-C.
  heartbeat.unref();

  // `res` is the documented place to observe a client going away: it does
  // not depend on IncomingMessage's close-timing semantics, which have
  // shifted across Node versions. This is what stops us writing to a dead
  // socket.
  function handleDisconnect(): void {
    if (closed) return;
    // The socket is already gone: nothing to end, and nothing worth
    // keeping queued for it.
    finish(false);
  }
  res.once("close", handleDisconnect);

  return {
    get closed() {
      return closed;
    },

    send(event: string, data: unknown): void {
      // Closing is a normal lifecycle step and the caller may legitimately
      // race it, or the client may have vanished with no way for the
      // caller to observe that synchronously — either way, silent no-op.
      if (closed) return;

      if (event === "" || event.includes("\n") || event.includes("\r")) {
        throw new TypeError(`invalid SSE event name: ${JSON.stringify(event)}`);
      }
      // JSON.stringify guarantees a single line, so the SSE multi-line
      // data: rule never applies here. Anything it cannot serialise
      // (BigInt, a circular reference) throws and propagates to the
      // caller unmodified — no placeholder is written in its place.
      const payload = JSON.stringify(data);
      // JSON.stringify returns the value undefined — not a string — not
      // only for `data === undefined`, but also for a function, a symbol,
      // or any object whose toJSON() returns undefined. Checking the
      // result (not just the input) is the one rule that covers all of
      // those: writing the literal bytes `data: undefined` would be a
      // fabricated, non-JSON payload on the wire, so this is a programmer
      // error rather than a value to write.
      if (payload === undefined) {
        throw new TypeError(`SSE data must serialise to JSON, got a value of type: ${typeof data}`);
      }
      emit(`event: ${event}\ndata: ${payload}\n\n`);
    },

    close(): void {
      if (closed) return;
      finish(true);
    },
  };
}
