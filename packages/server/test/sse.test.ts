import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openEventStream } from "../src/sse.js";
import type { EventStream } from "../src/sse.js";

// Real http.Server bound to port 0, driven by a real fetch() client, with
// assertions on the actual bytes written to the wire — the wire format is
// the contract, not the internal `closed` flag. Never hardcode a port:
// another executor's suite runs concurrently.

let servers: http.Server[] = [];

afterEach(async () => {
  // Always shut every server down, including on failure, or the suite
  // hangs on an open listening socket.
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers = [];
});

async function startServer(handler: http.RequestListener): Promise<{ url: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}` };
}

async function readChunk(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

describe("openEventStream", () => {
  it("writes SSE response headers", async () => {
    const { url } = await startServer((req, res) => {
      openEventStream(req, res);
    });

    const response = await fetch(url);
    await response.body?.cancel();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("send() writes one event: / data: block on the wire, terminated by a blank line", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
      stream.send("greeting", { hello: "world" });
    });

    const response = await fetch(url);
    const text = await readChunk(response);

    expect(text).toBe('event: greeting\ndata: {"hello":"world"}\n\n');
    stream!.close();
  });

  it("sends a heartbeat comment line on the configured interval when no events are sent", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res, { heartbeatMs: 20 });
    });

    const response = await fetch(url);
    const text = await readChunk(response);

    expect(text).toBe(": \n\n");
    stream!.close();
  });

  it("defaults heartbeatMs to 15000 when not supplied", async () => {
    const { url } = await startServer((req, res) => {
      expect(() => openEventStream(req, res)).not.toThrow();
      res.end();
    });

    await fetch(url).then((r) => r.body?.cancel());
  });

  it("throws for heartbeatMs 0, negative, or non-integer instead of clamping to a default", async () => {
    const { url } = await startServer((req, res) => {
      expect(() => openEventStream(req, res, { heartbeatMs: 0 })).toThrow();
      expect(() => openEventStream(req, res, { heartbeatMs: -1 })).toThrow();
      expect(() => openEventStream(req, res, { heartbeatMs: 1.5 })).toThrow();
      res.end();
    });

    await fetch(url).then((r) => r.body?.cancel());
  });

  it("throws for an event name that is empty or contains a newline, before writing anything", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
    });
    await fetch(url).then((r) => r.body?.cancel());

    expect(() => stream!.send("", { x: 1 })).toThrow();
    expect(() => stream!.send("bad\nname", { x: 1 })).toThrow();
    expect(() => stream!.send("bad\rname", { x: 1 })).toThrow();
    stream!.close();
  });

  it("throws when data is undefined, since JSON.stringify(undefined) is not a writable string", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
    });
    await fetch(url).then((r) => r.body?.cancel());

    expect(() => stream!.send("evt", undefined)).toThrow();
    stream!.close();
  });

  it("propagates the JSON.stringify error for unserialisable data instead of writing a placeholder", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
    });
    await fetch(url).then((r) => r.body?.cancel());

    expect(() => stream!.send("evt", 1n)).toThrow(TypeError);
    stream!.close();
  });

  it("throws instead of writing `data: undefined` when data serialises to undefined", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
    });
    await fetch(url).then((r) => r.body?.cancel());

    // A function: JSON.stringify(fn) === undefined.
    expect(() => stream!.send("evt", () => {})).toThrow(TypeError);
    // A symbol: JSON.stringify(symbol) === undefined.
    expect(() => stream!.send("evt", Symbol("x"))).toThrow(TypeError);
    // An object whose toJSON() itself returns undefined.
    expect(() => stream!.send("evt", { toJSON: () => undefined })).toThrow(TypeError);
    stream!.close();
  });

  it("close() ends the HTTP response and marks the stream closed", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
      setTimeout(() => stream.close(), 10);
    });

    const response = await fetch(url);
    const reader = response.body!.getReader();
    const result = await reader.read();

    expect(result.done).toBe(true);
    expect(stream!.closed).toBe(true);
  });

  it("close() is idempotent: a second call does nothing", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
    });
    await fetch(url).then((r) => r.body?.cancel());

    stream!.close();
    expect(stream!.closed).toBe(true);
    expect(() => stream!.close()).not.toThrow();
    expect(stream!.closed).toBe(true);
  });

  it("send() after close() is a silent no-op, not an error", async () => {
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
    });
    await fetch(url).then((r) => r.body?.cancel());

    stream!.close();

    expect(() => stream!.send("late", { x: 1 })).not.toThrow();
  });

  it("stops the heartbeat and marks the stream closed when the client disconnects", async () => {
    let stream: EventStream;
    let notifyDisconnect: () => void;
    const disconnected = new Promise<void>((resolve) => {
      notifyDisconnect = resolve;
    });
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res, { heartbeatMs: 20 });
      req.on("close", () => notifyDisconnect());
    });

    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    // Consume nothing further, then simulate the browser tab closing.
    controller.abort();
    await response.body?.cancel().catch(() => {});

    await disconnected;

    expect(stream!.closed).toBe(true);
    // send() after a disconnect must not attempt a write to the dead socket.
    expect(() => stream!.send("late", { x: 1 })).not.toThrow();
  });

  it("delivers an event sent asynchronously, after the route handler has already returned, to a connected client", async () => {
    // This is the primitive's entire reason to exist: a caller opens the
    // stream, returns from the request handler immediately, and pushes
    // events later from unrelated async work (e.g. a file watcher).
    let stream: EventStream;
    const { url } = await startServer((req, res) => {
      stream = openEventStream(req, res);
      // Handler returns here; nothing is written synchronously.
    });

    const response = await fetch(url);
    const reader = response.body!.getReader();

    // Give the response a moment to actually be in-flight before sending,
    // proving the client is already connected and waiting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    stream!.send("later", { pushed: true });

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toBe('event: later\ndata: {"pushed":true}\n\n');
    await reader.cancel();
    stream!.close();
  });
});
