import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";

// Ticket #37: startServe()'s close() used to hang whenever any connection was
// still active on the socket, because http.Server.close() closes *idle*
// connections on its own (Node >=18.19) but still waits indefinitely for any
// connection that is genuinely active — a request still arriving, or a
// response opened and never ended. This file proves close() resolves
// promptly from the outside (RunningServer.close(), driven with a real raw
// socket), the same Seam B convention serve.test.ts uses.
//
// Two SSE-based test designs were tried first and both turned out green even
// without the fix, on this Node version: `disposers` always ends every
// tracked SSE stream before server.close() runs, which converts it to an
// idle connection Node's own close() already reaps — and a completed plain
// HTTP request left idle in a keep-alive pool is reaped the same way.
// Neither can go red, so neither is a regression test. The one case below —
// a request still arriving, never routed, never tracked by anything — is
// the smallest deterministic representative of the whole failing class.

// Lazily spawned on the first chat message (see AgentChatSession), and this
// test never sends one — this fixture is never actually spawned, it only
// satisfies the required `agent` field on ServeOptions. Same trick
// serve.test.ts already uses.
const fakeAgentFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "agent/fixtures/fake-acp-agent.mjs",
);
const fakeAgent: AgentAdapterConfig = {
  kind: "claude",
  label: "Claude Code",
  command: process.execPath,
  args: [fakeAgentFixture],
};

// Measured, not guessed: with the fix, close() resolves in 0-1ms; without
// it, it does not resolve at all (the field observation was a 240s hang).
// 1000ms sits far above the real work and far below any plausible natural
// expiry, so it cleanly separates the two outcomes.
const CLOSE_DEADLINE_MS = 1000;

let coMotionHome: string;
let comotDir: string;
let staticRoot: string;
let registry: CommandRegistry;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-serve-close-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-serve-close-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "co-motion-serve-close-static-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(staticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function openFreshPresentation(name = "測試簡報"): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function serve(presentationId: string): Promise<RunningServer> {
  const server = await startServe({
    registry,
    presentationId,
    port: 0,
    agent: fakeAgent,
    staticDir: path.join(staticRoot, "dist"),
  });
  servers.push(server);
  return server;
}

/** Races close() against a deadline that names what was still connected. */
async function closeWithinDeadline(server: RunningServer, whatWasConnected: string): Promise<void> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`close() did not resolve within ${CLOSE_DEADLINE_MS}ms while ${whatWasConnected}`));
    }, CLOSE_DEADLINE_MS);
  });
  try {
    await Promise.race([server.close(), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

function connectSocket(port: number, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Waits one macrotask so a just-written socket chunk has reached the server. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

// close() resolving is not itself evidence the connection was actually
// released: a Promise.race/setTimeout-based "fix" (forbidden approach #1)
// would resolve close() on a deadline while leaving the socket held open,
// and closeWithinDeadline alone would not catch that. Asserting the client
// observes the server's end of the connection close (an EOF) is what would.
const SOCKET_RELEASE_DEADLINE_MS = 500;

/** Asserts the socket's remote end actually closed, under its own deadline. */
function assertSocketReleased(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `socket never observed the server closing its end within ${SOCKET_RELEASE_DEADLINE_MS}ms after close() resolved`,
        ),
      );
    }, SOCKET_RELEASE_DEADLINE_MS);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("RunningServer.close()", () => {
  it("resolves promptly while a request is still in flight (headers begun, never terminated) on the socket", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);
    servers = servers.filter((s) => s !== server); // this test closes it itself

    const port = Number(new URL(server.url).port);
    const host = new URL(server.url).hostname;
    const socket = await connectSocket(port, host);
    // Headers begun but deliberately never terminated (no closing blank
    // line) — the server is still waiting on the rest of the request, so
    // this connection is active, not idle, and nothing in serve.ts tracks
    // it. Never routed, so no disposer can touch it either.
    const partialRequest = "GET /api/presentation HTTP/1.1\r\nHost: 127.0.0.1\r\n";
    socket.write(partialRequest);
    await tick();

    try {
      await closeWithinDeadline(server, "a request was still in flight on the socket");
      await assertSocketReleased(socket);
    } finally {
      socket.destroy();
    }
  });
});
