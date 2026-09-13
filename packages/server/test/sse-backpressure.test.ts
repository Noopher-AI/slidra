// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openEventStream } from "../src/sse.js";
import type { EventStream } from "../src/sse.js";

// Real http.Server + a real TCP socket client whose reading we control, so
// backpressure comes from the kernel socket buffer actually filling up —
// not from a stubbed `write()` that returns false on cue.

let servers: http.Server[] = [];
let sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets = [];
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

/**
 * Starts a server that opens one event stream per request and hands the
 * caller a promise for it, so a test can drive the server side directly
 * while the client side stays a real socket.
 */
async function startStreamServer(): Promise<{ port: number; stream: Promise<EventStream> }> {
  let resolveStream!: (stream: EventStream) => void;
  const stream = new Promise<EventStream>((resolve) => {
    resolveStream = resolve;
  });
  const server = http.createServer((_req, res) => {
    resolveStream(openEventStream(res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, stream };
}

/**
 * A client that opens the SSE request and then reads nothing until told
 * to. `pause()` on a real socket stops draining the kernel receive buffer,
 * which is what eventually makes the server's `res.write()` return false.
 */
async function connectSilentClient(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.pause();
  socket.write("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n");
  return socket;
}

/** 5KB per event — the chunk size the ticket's measurements used. */
const BIG_PAYLOAD = "x".repeat(5 * 1024);

describe("openEventStream backpressure", () => {
  it("stops buffering for a client that never reads, instead of growing without bound", async () => {
    const server = await startStreamServer();
    await connectSilentClient(server.port);
    const stream = await server.stream;

    // 8000 x 5KB is the ticket's own slow-reader scenario (~40MB). A
    // client that reads nothing must not make us hold all of it.
    let sent = 0;
    for (let i = 0; i < 8000; i += 1) {
      if (stream.closed) break;
      stream.send("chunk", { text: BIG_PAYLOAD });
      sent += 1;
    }

    // Dropped rather than buffered: the stream ends, bounded by the
    // buffer cap instead of by how much the caller offered.
    expect(stream.closed).toBe(true);
    expect(sent).toBeLessThan(8000);
  });

  it("delivers every event, in order, once a paused client resumes reading", async () => {
    // ~770KB of frames: comfortably inside the buffer cap, so this
    // exercises the queue-then-drain path without touching the overflow
    // rule the previous test covers.
    const total = 150;
    const server = await startStreamServer();
    const socket = await connectSilentClient(server.port);
    const stream = await server.stream;

    // Paused: these go through the drain path rather than straight out.
    for (let i = 0; i < total; i += 1) {
      stream.send("chunk", { i, text: BIG_PAYLOAD });
    }

    const received = await readEventIndexes(socket, total);

    expect(stream.closed).toBe(false);
    expect(received).toEqual(Array.from({ length: total }, (_unused, i) => i));
  });
});

/** Resumes the socket and collects the `i` field of each event received. */
function readEventIndexes(socket: net.Socket, total: number): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    let buffer = "";
    const count = (text: string): number => text.split("\n\n").length - 1;
    const timer = setTimeout(() => reject(new Error(`逾時：只收到 ${count(buffer)}/${total} 個事件`)), 10000);
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (count(buffer) < total) return;
      clearTimeout(timer);
      resolve([...buffer.matchAll(/data: (\{"i":\d+.*?\})\n\n/g)].map((m) => (JSON.parse(m[1]) as { i: number }).i));
    });
    socket.resume();
  });
}
