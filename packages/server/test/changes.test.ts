import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import { createChangeBroadcaster } from "../src/changes.js";

/**
 * Minimal stand-in for `http.ServerResponse`, used only for the
 * dispose()-race test below, where the point under test is promise
 * ordering inside `changes.ts` itself — not the wire format `openEventStream`
 * writes, which sse.test.ts and the Seam B tests above already cover
 * against a real socket. Implements exactly what `openEventStream` touches:
 * `writeHead`/`flushHeaders`/`write`/`end`, plus `once("close", ...)` /
 * `removeListener` via EventEmitter.
 */
class FakeResponse extends EventEmitter {
  writeHead(): void {}
  flushHeaders(): void {}
  write(): void {}
  end(): void {}
}

// Seam B: start the real server, drive /api/events over HTTP with a real
// fetch(), never open a browser. Always bind port 0 and read the assigned
// port back — a hardcoded port collides with ticket #6's concurrently
// running suite. Presentation state is only ever read through
// registry.dispatch("cat", ...), the same read path `co-motion cat` uses —
// never a direct poke at the work directory's real path.

let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let servers: RunningServer[];
let streams: Array<{ cancel: () => Promise<void> }>;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-changes-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-changes-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
  streams = [];
});

afterEach(async () => {
  // Always tear every stream and server down, including on assertion
  // failure, or the suite hangs on an open SSE connection / listening
  // socket.
  await Promise.all(streams.map((stream) => stream.cancel()));
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

async function serve(presentationId: string): Promise<RunningServer> {
  const server = await startServe({ registry, presentationId, port: 0 });
  servers.push(server);
  return server;
}

async function openFreshPresentation(name = "測試簡報"): Promise<{ id: string; elementId: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const slide = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  const match = slide.data!.content.match(/<text id="([^"]+)"/);
  if (!match) {
    throw new Error("test fixture is missing the expected <text id=…> element");
  }
  return { id, elementId: match[1] };
}

/**
 * Reads complete SSE frames off a Response body, one frame per call.
 * Copied from sse.test.ts's `createFrameReader` — accumulating decoded
 * bytes until the blank-line frame terminator is the one piece of that
 * suite explicitly worth reusing rather than reinventing here.
 */
function createFrameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async readFrame(): Promise<string> {
      let terminatorIndex = buffer.indexOf("\n\n");
      while (terminatorIndex === -1) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("SSE stream ended before a complete frame was received");
        }
        buffer += decoder.decode(value, { stream: true });
        terminatorIndex = buffer.indexOf("\n\n");
      }
      const frame = buffer.slice(0, terminatorIndex + 2);
      buffer = buffer.slice(terminatorIndex + 2);
      return frame;
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => {});
    },
  };
}

async function connectEvents(server: RunningServer) {
  const response = await fetch(`${server.url}/api/events`);
  const frameReader = createFrameReader(response);
  streams.push(frameReader);
  return frameReader;
}

async function setText(id: string, elementId: string, newText: string) {
  const result = await registry.dispatch("text set", { id, slidePath: "slides/001.svg", elementId, newText });
  expect(result.ok).toBe(true);
}

describe("GET /api/events", () => {
  it("pushes a presentation-changed event with no payload when a slide is modified externally", async () => {
    const { id, elementId } = await openFreshPresentation();
    const server = await serve(id);
    const frameReader = await connectEvents(server);

    await setText(id, elementId, "改過的標題");

    const frame = await frameReader.readFrame();
    expect(frame).toBe("event: presentation-changed\ndata: {}\n\n");
  });

  it("delivers a notification for each of several sequential modifications, awaiting between them", async () => {
    const { id, elementId } = await openFreshPresentation();
    const server = await serve(id);
    const frameReader = await connectEvents(server);

    for (const text of ["第一次修改", "第二次修改", "第三次修改"]) {
      await setText(id, elementId, text);
      const frame = await frameReader.readFrame();
      expect(frame).toBe("event: presentation-changed\ndata: {}\n\n");
    }
  });

  it("keeps delivering events to a second tab after a first tab disconnects", async () => {
    const { id, elementId } = await openFreshPresentation();
    const server = await serve(id);

    const first = await connectEvents(server);
    const second = await connectEvents(server);

    // The first tab closes its browser tab.
    await first.cancel();

    await setText(id, elementId, "只有第二個分頁還在");

    const frame = await second.readFrame();
    expect(frame).toBe("event: presentation-changed\ndata: {}\n\n");
  });

  it("close() on the running server returns promptly even with a client still connected", async () => {
    const { id } = await openFreshPresentation();
    const server = await serve(id);
    await connectEvents(server);

    // server.close() alone would hang forever waiting for the still-open
    // SSE connection; startServe's close() must tear the stream down first.
    await expect(server.close()).resolves.toBeUndefined();

    // Prevent afterEach from calling close() again on an already-closed
    // server.
    servers = servers.filter((s) => s !== server);
  });

  it("dispose() concludes a connection that resumes from the lazy watcher start after shutdown already began", async () => {
    // Ticket #5 fix 3: if shutdown starts while a /api/events request is
    // still awaiting the lazy watcher start, dispose() must not tear the
    // watcher down and then let that same request open a stream anyway —
    // server.close() waits for established connections, so a late stream
    // would hang shutdown forever.
    //
    // handleConnection() and dispose() are called back-to-back, with
    // neither awaited first: handleConnection's `await ensureWatcher()`
    // and dispose()'s `await watcherPromise...` both end up awaiting the
    // exact same underlying promise, and JS guarantees continuations on
    // one promise run in the order they were attached — handleConnection
    // attached first, so this reproduces "resumes after shutdown already
    // began" deterministically rather than by chance timing.
    const { id } = await openFreshPresentation();
    const broadcaster = createChangeBroadcaster(id);
    const res = new FakeResponse() as unknown as ServerResponse;

    const connectionPromise = broadcaster.handleConnection(res);
    const disposePromise = broadcaster.dispose();

    await expect(disposePromise).resolves.toBeUndefined();
    // The resumed connection must be concluded — rejected — never left
    // open as a stream nobody will ever close.
    await expect(connectionPromise).rejects.toThrow();
  });

  it("responds with an explicit error, not an open stream, when the watcher fails to start for an unknown id", async () => {
    // A registry stub whose id is not registered in the real CO_MOTION_HOME
    // registry watchPresentation looks up (see the equivalent stub-registry
    // test in serve.test.ts): loadProject succeeds through the stub, but
    // watching the underlying work directory cannot, since it never
    // existed. The failure must surface as an explicit HTTP error, not a
    // silently-opened stream.
    const stubRegistry = new CommandRegistry();
    stubRegistry.register("cat", {
      handler: async (input: unknown) => {
        const { path: virtualPath } = input as { path: string };
        if (virtualPath === "project.json") {
          return {
            ok: true,
            data: {
              content: JSON.stringify({
                formatVersion: 1,
                name: "Stub",
                canvas: { width: 1, height: 1 },
                slides: ["slides/fake.svg"],
              }),
            },
            message: "",
          };
        }
        return { ok: false, message: `找不到檔案：${virtualPath}` };
      },
      render: null,
    });
    const server = await startServe({ registry: stubRegistry, presentationId: "unregistered-stub-id", port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/api/events`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/找不到識別碼對應的簡報/);
  });
});
