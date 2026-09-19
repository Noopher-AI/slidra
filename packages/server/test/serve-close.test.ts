// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { connect, type Socket } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import { openPolicy } from "../src/policy/open.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";

const execFileAsync = promisify(execFile);
const slidraBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../target/release/slidra");

interface CliEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
  failureKind?: string;
}

async function runCli<T = unknown>(args: string[]): Promise<CliEnvelope<T>> {
  try {
    const { stdout } = await execFileAsync(slidraBinPath, [...args, "--json"], { env: process.env });
    return JSON.parse(stdout.trim()) as CliEnvelope<T>;
  } catch (error) {
    const err = error as { stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
      return JSON.parse(err.stdout.trim()) as CliEnvelope<T>;
    }
    throw error;
  }
}

// startServe()'s close() used to hang whenever any connection was
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

let slidraHome: string;
let slidraDir: string;
let staticRoot: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-serve-close-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-serve-close-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "slidra-serve-close-static-"));
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(staticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function openFreshPresentation(name = "Test Presentation"): Promise<string> {
  const slidraPath = path.join(slidraDir, "deck.slidra");
  const created = await runCli(["new", slidraPath, "--name", name]);
  if (!created.ok) throw new Error(created.message);
  return slidraPath;
}

async function serve(deckPath: string): Promise<RunningServer> {
  const server = await startServe({
    policy: openPolicy,
    presentationId: deckPath,
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
  it("removes the child process workbench from an isolated TMPDIR without changing the deck", async () => {
    const deckPath = await openFreshPresentation("shutdown cleanup");
    const deckBefore = await readFile(deckPath);
    const isolatedTmp = await mkdtemp(path.join(tmpdir(), "slidra-deck-server-tmp-"));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    try {
      const server = await serve(deckPath);
      servers = servers.filter((candidate) => candidate !== server);
      const duringEntries = await readdir(isolatedTmp, { withFileTypes: true });
      const during = [];
      for (const entry of duringEntries) {
        if (!entry.isDirectory()) continue;
        try {
          await readFile(path.join(isolatedTmp, entry.name, "deck"));
          during.push(entry.name);
        } catch {
          // Other child-owned temp directories are not workbenches.
        }
      }
      if (during.length !== 1) throw new Error(`expected one runtime workbench, found ${JSON.stringify(during)}`);

      await server.close();

      const after = await readdir(isolatedTmp);
      if (after.includes(during[0])) throw new Error(`runtime workbench survived shutdown: ${JSON.stringify(after)}`);
      const deckAfter = await readFile(deckPath);
      if (!deckAfter.equals(deckBefore)) throw new Error("opening and closing changed the deck bytes");
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });

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
