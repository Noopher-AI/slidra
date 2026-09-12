// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { SlidraError } from "../src/slidra/errors.js";
import { createChatStreamRegistry } from "../src/serve.js";
import type { AgentChatSession } from "../src/agent/session.js";

// `/api/chat/stream` used to open a stream no matter what, so a
// browser's EventSource — which reconnects by design the moment a stream is
// cut — could get a brand new, never-ending stream out of a server that had
// already started shutting down, after the shutdown had finished closing
// every stream it knew about. `changes.ts` refuses in the same situation;
// this is the missing half of that symmetry.
//
// Driven over a real socket with a real fetch(), the same convention
// sse.test.ts uses: the wire is the contract. The shutdown window inside
// startServe().close() is about a millisecond wide, so racing a request
// into it would be a flaky test, not a regression test — the guard is
// tested where it lives instead.

let servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers = [];
});

/** Never spawns anything: the registry only ever calls attachStream. */
const fakeChatSession = {
  attachStream: () => () => {},
} as unknown as AgentChatSession;

/**
 * Serves `registry.open()` on every request, mapping a thrown SlidraError
 * to a 500 the way serve.ts's own handleRequest does.
 */
async function serveRegistry(registry: ReturnType<typeof createChatStreamRegistry>): Promise<string> {
  const server = http.createServer((_req, res) => {
    try {
      registry.open(fakeChatSession, res);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof SlidraError ? error.message : "Unknown error" }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("before shutdown, /api/chat/stream opens an SSE stream as usual", async () => {
  const registry = createChatStreamRegistry();
  const url = await serveRegistry(registry);

  const response = await fetch(url);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  await response.body?.cancel();
});

it("once shutdown has begun, /api/chat/stream returns an explicit error instead of opening a stream nobody will close", async () => {
  const registry = createChatStreamRegistry();
  const url = await serveRegistry(registry);

  // This is exactly what close()'s disposer does — it closes every stream
  // that currently exists. server.close() only comes after that, and
  // EventSource will auto-reconnect in between.
  registry.closeAll();

  const response = await fetch(url);

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Server is shutting down" });
  expect(response.headers.get("content-type")).not.toContain("text/event-stream");
});
