import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A single open Server-Sent Events connection. Shared primitive for ticket
 * #5 (file-changed reload events) and ticket #6 (streamed agent replies) —
 * this module owns SSE framing so neither consumer reinvents it.
 */
export interface EventStream {
  /** True once the stream is finished, whether by close() or by the client disconnecting. */
  readonly closed: boolean;
  send(event: string, data: unknown): void;
  close(): void;
}

const DEFAULT_HEARTBEAT_MS = 15000;

/**
 * Writes SSE response headers on `res` and returns a handle to push events
 * over it. `req`/`res` must already be matched to the SSE route by the
 * caller — this function only frames the protocol, it does no routing.
 */
export function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { heartbeatMs?: number },
): EventStream {
  const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0) {
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

  const heartbeat = setInterval(() => {
    // A bare comment line: no event, no data, just keeps the connection
    // (and any intermediary proxy) from timing it out.
    res.write(": \n\n");
  }, heartbeatMs);
  // Must be unref'd: a live setInterval keeps the Node event loop alive,
  // which would hang the test suite and stop `co-motion serve` from ever
  // exiting on Ctrl-C.
  heartbeat.unref();

  // `res` is the documented place to observe a client going away: it does
  // not depend on IncomingMessage's close-timing semantics, which have
  // shifted across Node versions. This is what stops us writing to a dead
  // socket.
  const handleDisconnect = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };
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
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
    },

    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.removeListener("close", handleDisconnect);
      res.end();
    },
  };
}
