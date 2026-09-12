import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import { createChangeBroadcaster } from "../src/changes.js";
import { workDirFor } from "../src/comotion/home.js";

const execFileAsync = promisify(execFile);
const coMotionBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../target/release/comotion");

interface CliEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
  failureKind?: string;
}

async function runCli<T = unknown>(args: string[]): Promise<CliEnvelope<T>> {
  try {
    const { stdout } = await execFileAsync(coMotionBinPath, [...args, "--json"], { env: process.env });
    return JSON.parse(stdout.trim()) as CliEnvelope<T>;
  } catch (error) {
    const err = error as { stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
      return JSON.parse(err.stdout.trim()) as CliEnvelope<T>;
    }
    throw error;
  }
}

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
// running suite. Presentation state is only ever read through the real
// `comotion cat` binary — never a direct poke at the work directory's
// real path.

let coMotionHome: string;
let comotDir: string;
let servers: RunningServer[];
let streams: Array<{ cancel: () => Promise<void> }>;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "comotion-changes-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "comotion-changes-files-"));
  process.env.COMOTION_HOME = coMotionHome;
  process.env.COMOTION_BIN = coMotionBinPath;
  servers = [];
  streams = [];
});

afterEach(async () => {
  // Always tear every stream and server down, including on assertion
  // failure, or the suite hangs on an open SSE connection / listening
  // socket.
  await Promise.all(streams.map((stream) => stream.cancel()));
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.COMOTION_HOME;
  delete process.env.COMOTION_BIN;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function serve(presentationId: string): Promise<RunningServer> {
  const server = await startServe({ presentationId, port: 0 });
  servers.push(server);
  return server;
}

async function openFreshPresentation(name = "測試簡報"): Promise<{ id: string; elementId: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  const created = await runCli(["new", comotPath, "--name", name]);
  expect(created.ok).toBe(true);
  const opened = await runCli<{ id: string }>(["open", comotPath]);
  expect(opened.ok).toBe(true);
  // `new` creates no slides (ADR-0018, #303): the tests below edit
  // slides/001.svg, so mint one page with one title text box.
  const id = opened.data!.id;
  expect((await runCli(["slide", "add", id])).ok).toBe(true);
  const added = await runCli<{ elementId: string }>([
    "textbox", "add", id, "slides/001.svg", "--x", "80", "--y", "80", "--width", "600", "--text", name,
  ]);
  expect(added.ok).toBe(true);
  const elementId = added.data!.elementId;
  if (typeof elementId !== "string" || elementId === "") {
    throw new Error("textbox add did not report the new element's id");
  }
  return { id, elementId };
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
  const result = await runCli(["text", "set", id, "slides/001.svg", elementId, newText]);
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

  it("ignores the CLI's .comotion.lock, so a read command does not look like a change", async () => {
    // #303 regression: the lock is created and removed around every CLI
    // command, reads included, inside the watched work directory. Treating
    // it as content made every live-reload trigger a re-read that took the
    // lock again — an endless reload loop that dropped the author's
    // selection the moment they clicked an element.
    const { id, elementId } = await openFreshPresentation();
    const server = await serve(id);
    const frameReader = await connectEvents(server);

    const lockPath = path.join(await workDirFor(id), ".comotion.lock");
    for (let i = 0; i < 3; i++) {
      await writeFile(lockPath, "");
      await rm(lockPath);
    }

    // One read, raced twice: the reader may only be pulled once, or the
    // losing promise swallows the frame the second assertion waits for.
    const pending = frameReader.readFrame();
    const timeout = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

    // Well past the watcher's 100ms debounce: nothing may have arrived.
    expect(await Promise.race([pending, timeout(500)])).toBe(null);

    // A real edit still gets through — the filter skips the lock, not the
    // notification path itself.
    await setText(id, elementId, "鎖檔不算改動");
    expect(await pending).toBe("event: presentation-changed\ndata: {}\n\n");
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
    // [E4.T9]/F7: a fake COMOTION_BIN that answers `cat <id> project.json`
    // for ANY id, real or not (the equivalent stub-registry test in
    // serve.test.ts uses the same technique) — loadProject succeeds
    // through it, but `watchPresentation`'s `workDirFor` reads the REAL
    // `COMOTION_HOME/projects.json` directly (comotion/home.ts, not the
    // CLI), which has no entry for this id at all. The failure must
    // surface as an explicit HTTP error, not a silently-opened stream.
    const fakeBinDir = await mkdtemp(path.join(tmpdir(), "comotion-changes-fakebin-"));
    const fakeBinPath = path.join(fakeBinDir, "comotion-fake.mjs");
    await writeFile(
      fakeBinPath,
      [
        "#!/usr/bin/env node",
        'const args = process.argv.slice(2).filter((a) => a !== "--json");',
        "const [cmd, ...rest] = args;",
        "function b64(s) { return Buffer.from(s, \"utf-8\").toString(\"base64\"); }",
        "let result;",
        'if (cmd === "cat" && rest[1] === "project.json") {',
        "  const content = JSON.stringify({ formatVersion: 4, name: \"Stub\", canvas: { width: 1, height: 1 }, slides: [\"slides/fake.svg\"] });",
        '  result = { ok: true, data: [{ path: "project.json", content: b64(content) }], message: "已讀取：project.json" };',
        "} else {",
        '  result = { ok: false, message: "找不到檔案：" + rest.join(" "), failureKind: "not-found" };',
        "}",
        "process.stdout.write(JSON.stringify(result) + \"\\n\");",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    process.env.COMOTION_BIN = fakeBinPath;
    try {
      const server = await startServe({ presentationId: "unregistered-stub-id", port: 0 });
      servers.push(server);

      const response = await fetch(`${server.url}/api/events`);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/找不到識別碼對應的簡報/);
    } finally {
      process.env.COMOTION_BIN = coMotionBinPath;
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it("registers stream cleanup at connection time, so a disconnect is pruned immediately rather than waiting on the next file change", async () => {
    // Ticket #5 fix round, fix 3: a long-running server whose clients
    // reconnect repeatedly (EventSource does this by design on any network
    // blip) must not accumulate dead EventStream objects until something
    // unrelated happens to prune them. The cleanup listener must be
    // attached alongside `streams.add(stream)`, not left to the lazy sweep
    // inside the change handler.
    const { id } = await openFreshPresentation();
    const broadcaster = createChangeBroadcaster(id);
    const res = new FakeResponse() as unknown as ServerResponse;

    await broadcaster.handleConnection(res);
    // openEventStream (sse.ts) registers its own `once("close", ...)`
    // disconnect listener; changes.ts must register a second one at the
    // same moment the stream is added to the fan-out set.
    expect((res as unknown as EventEmitter).listenerCount("close")).toBe(2);

    (res as unknown as EventEmitter).emit("close");

    // Both `once` listeners fire on the same disconnect and remove
    // themselves — this only happens if the cleanup was already wired up
    // by the time the client disconnected, not deferred to some later
    // event.
    expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);

    await broadcaster.dispose();
  });

  it("responds without the real work directory path when fs.watch fails synchronously at startup", async () => {
    // ADR-0004's third layer failing exactly where it matters: `fs.watch`
    // throws synchronously (not only via its async `error` event) when the
    // work directory has vanished between server startup and the first
    // /api/events request — removing it here reproduces exactly that gap.
    const { id } = await openFreshPresentation();
    const server = await serve(id);
    const workDir = await workDirFor(id);
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    const response = await fetch(`${server.url}/api/events`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toContain(workDir);
    expect(body.error).not.toContain(coMotionHome);
  });
});
