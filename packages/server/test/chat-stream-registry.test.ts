import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { CoMotionError } from "@co-motion/core";
import { createChatStreamRegistry } from "../src/serve.js";
import type { AgentChatSession } from "../src/agent/session.js";

// Ticket #40: `/api/chat/stream` used to open a stream no matter what, so a
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
 * Serves `registry.open()` on every request, mapping a thrown CoMotionError
 * to a 500 the way serve.ts's own handleRequest does.
 */
async function serveRegistry(registry: ReturnType<typeof createChatStreamRegistry>): Promise<string> {
  const server = http.createServer((_req, res) => {
    try {
      registry.open(fakeChatSession, res);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof CoMotionError ? error.message : "未知錯誤" }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("關機前，/api/chat/stream 照常開出 SSE 串流", async () => {
  const registry = createChatStreamRegistry();
  const url = await serveRegistry(registry);

  const response = await fetch(url);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  await response.body?.cancel();
});

it("關機開始後，/api/chat/stream 明確回錯誤，而不是開出一條沒人會關的串流", async () => {
  const registry = createChatStreamRegistry();
  const url = await serveRegistry(registry);

  // 這正是 close() 的 disposer 做的事——關掉當下所有串流。之後才輪到
  // server.close()，而 EventSource 會在這中間自動重連進來。
  registry.closeAll();

  const response = await fetch(url);

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "伺服器正在關閉" });
  expect(response.headers.get("content-type")).not.toContain("text/event-stream");
});
