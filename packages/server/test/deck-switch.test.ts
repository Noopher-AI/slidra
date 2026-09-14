// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";
import { createDeckSession, DeckSwitchConflictError, type DeckIdentity } from "../src/deck-switch.js";
import { readProjectsRegistry, resolveSlidraHome } from "../src/slidra/home.js";

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

// Seam B for the HTTP-level tests below: a real server, real HTTP, the real
// `slidra` binary for every read/write — no mocks, no browser.

const fakeAgentFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "agent/fixtures/fake-acp-agent.mjs");

let slidraHome: string;
let slidraDir: string;
let deckFolder: string;
let staticRoot: string;
let servers: RunningServer[];
let streams: Array<{ cancel: () => Promise<void> }>;

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-deckswitch-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-deckswitch-files-"));
  deckFolder = await mkdtemp(path.join(tmpdir(), "slidra-deckswitch-deckfolder-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "slidra-deckswitch-static-"));
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
  // [E6.T2]: /api/new, /api/open, and GET /api/decks now resolve a real
  // deck folder (default ~/Slidra) — pointed at an isolated temp dir so
  // these tests never touch the real host home directory.
  await writeFile(path.join(slidraHome, "settings.json"), JSON.stringify({ deckFolder }));
  servers = [];
  streams = [];
});

afterEach(async () => {
  await Promise.all(streams.map((stream) => stream.cancel()));
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(deckFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(staticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Creates a fresh one-slide deck (real `new`+`open`+`slide add`, real bytes on disk) and returns its id and the real `.slidra` file path `open` read it from. */
async function createDeck(name: string): Promise<{ id: string; slidraPath: string }> {
  const slidraPath = path.join(slidraDir, `${name}.slidra`);
  const created = await runCli(["new", slidraPath, "--name", name]);
  expect(created.ok).toBe(true);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
  const id = opened.data!.id;
  expect((await runCli(["slide", "add", id])).ok).toBe(true);
  return { id, slidraPath };
}

async function serve(overrides: Partial<Parameters<typeof startServe>[0]> = {}): Promise<RunningServer> {
  const server = await startServe({ port: 0, staticDir: path.join(staticRoot, "dist"), ...overrides });
  servers.push(server);
  return server;
}

async function readSlide(id: string): Promise<string> {
  const result = await runCli<Array<{ path: string; content: string }>>(["cat", id, "slides/001.svg"]);
  expect(result.ok).toBe(true);
  return Buffer.from(result.data![0]!.content, "base64").toString("utf-8");
}

function postJson(server: RunningServer, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function switchTo(server: RunningServer, id: string): Promise<Response> {
  return postJson(server, "/api/deck/switch", { id });
}

// --- fingerprinting (AC3/AC5): path+sha256 of every file under a
// directory, or of one file, so "byte-for-byte unchanged" is an assertion
// on real bytes rather than on a timestamp or a listing. Absent is its own
// distinct value — a directory that never existed and one that existed
// and got emptied must not compare equal to "still has the same files".

async function fingerprintDir(dir: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "<absent>";
    throw error;
  }
  const lines: string[] = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    let bytes: Buffer;
    try {
      bytes = await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EISDIR") {
        lines.push(`${name} <dir>`);
        continue;
      }
      throw error;
    }
    lines.push(`${name} ${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return lines.join("\n");
}

async function fingerprintFile(filePath: string): Promise<string> {
  try {
    const bytes = await readFile(filePath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "<absent>";
    throw error;
  }
}

/** The four locations NOOP-433 AC3 promises are untouched by switching away from `id`: its deck file's directory, its history, its deployed agent work directory, and the real `.slidra` file `open` read it from. */
async function fingerprintDeck(id: string, slidraPath: string): Promise<Record<string, string>> {
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  if (!entry) throw new Error(`test fixture: registry has no entry for ${id}`);
  const home = resolveSlidraHome();
  return {
    deckDir: await fingerprintDir(path.dirname(entry.deckPath)),
    history: await fingerprintDir(path.join(home, "history", id)),
    agentWorkdir: await fingerprintDir(path.join(home, "agent", id)),
    slidraFile: await fingerprintFile(slidraPath),
  };
}

/** Copied from changes.test.ts's `createFrameReader` — accumulates decoded bytes until the blank-line SSE frame terminator. */
function createFrameReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async readFrame(): Promise<string> {
      let terminatorIndex = buffer.indexOf("\n\n");
      while (terminatorIndex === -1) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended before a complete frame was received");
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

function eventNameOf(frame: string): string {
  const line = frame.split("\n").find((l) => l.startsWith("event: "));
  if (!line) throw new Error(`frame carries no event line: ${JSON.stringify(frame)}`);
  return line.slice("event: ".length);
}

async function connectEvents(server: RunningServer) {
  const response = await fetch(`${server.url}/api/events`);
  const frameReader = createFrameReader(response);
  streams.push(frameReader);
  return frameReader;
}

describe("no deck open (AC1)", () => {
  it("① every deck-scoped route answers 409 {reason:\"no-deck\"} — no unhandled error, no 500", async () => {
    const server = await serve();

    const routes: Array<{ method: "GET" | "POST"; path: string }> = [
      { method: "GET", path: "/api/presentation" },
      { method: "GET", path: "/api/assets" },
      { method: "GET", path: "/api/files/project.json" },
      { method: "GET", path: "/api/effects/slides/001.svg" },
      { method: "GET", path: "/api/raw/project.json" },
      { method: "GET", path: "/api/save-state" },
      { method: "POST", path: "/api/command" },
      { method: "POST", path: "/api/asset" },
      { method: "POST", path: "/api/save" },
      { method: "POST", path: "/api/undo" },
      { method: "POST", path: "/api/redo" },
      { method: "POST", path: "/api/export" },
      { method: "POST", path: "/api/chat" },
    ];

    for (const route of routes) {
      const response = await fetch(`${server.url}${route.path}`, {
        method: route.method,
        headers: route.method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: route.method === "POST" ? "{}" : undefined,
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(409);
      const json = await response.json();
      expect(json, `${route.method} ${route.path}`).toEqual({ error: "No deck is open", reason: "no-deck" });
    }
  });

  it("② deck-independent routes still answer 200 with no deck open", async () => {
    const server = await serve();

    const deckGet = await fetch(`${server.url}/api/deck`);
    expect(deckGet.status).toBe(200);
    expect(await deckGet.json()).toEqual({ deck: null });

    const agentGet = await fetch(`${server.url}/api/agent`);
    expect(agentGet.status).toBe(200);
    expect((await agentGet.json()).current).toBeNull();

    const probe = await fetch(`${server.url}/api/agent/probe`, { method: "POST" });
    expect(probe.status).toBe(200);

    const commands = await fetch(`${server.url}/api/agent/commands`);
    expect(commands.status).toBe(200);
    expect(await commands.json()).toEqual({ commands: [] });

    const select = await postJson(server, "/api/agent/select", { kind: "claude" });
    expect(select.status).toBe(200);
    const selectJson = await select.json();
    expect(selectJson).toEqual({ ok: true, current: "claude", source: "settings" });

    // [E6.T2]: the deck lifecycle routes are deck-session-independent too —
    // none of them touch this server's (non-existent) currently-open deck.
    const decksGetBefore = await fetch(`${server.url}/api/decks`);
    expect(decksGetBefore.status).toBe(200);
    expect(await decksGetBefore.json()).toEqual({ decks: [] });

    const created = await postJson(server, "/api/new", { name: "Independent" });
    expect(created.status).toBe(200);
    const createdJson = (await created.json()) as { ok: boolean; id: string; fileName: string };
    expect(createdJson.ok).toBe(true);
    expect(createdJson.fileName).toBe("Independent.slidra");

    const uploadSourcePath = path.join(slidraDir, "uploaded.slidra");
    expect((await runCli(["new", uploadSourcePath, "--name", "Uploaded"])).ok).toBe(true);
    const uploadBytes = await readFile(uploadSourcePath);
    const opened = await fetch(`${server.url}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-slidra-file-name": "Uploaded.slidra" },
      body: uploadBytes,
    });
    expect(opened.status).toBe(200);
    const openedJson = (await opened.json()) as { ok: boolean; id: string };
    expect(openedJson.ok).toBe(true);
    expect(openedJson.id).not.toBe(createdJson.id);
  });
});

describe("switching (AC3/AC4/AC5)", () => {
  it("③ A→B: B's content is served", async () => {
    const a = await createDeck("deck-a");
    const b = await createDeck("deck-b");
    const server = await serve({ presentationId: a.id });

    const response = await switchTo(server, b.id);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ ok: true, switched: true, deck: { id: b.id, name: "deck-b" } });

    const presentation = await fetch(`${server.url}/api/presentation`);
    expect(presentation.status).toBe(200);
    expect((await presentation.json()).name).toBe("deck-b");
  });

  it("④ A's four fingerprints (work dir, history, agent workdir, .slidra file) are byte-for-byte unchanged after switching to B", async () => {
    const a = await createDeck("deck-a");
    const b = await createDeck("deck-b");
    const server = await serve({ presentationId: a.id });
    const before = await fingerprintDeck(a.id, a.slidraPath);

    const response = await switchTo(server, b.id);
    expect(response.status).toBe(200);

    const after = await fingerprintDeck(a.id, a.slidraPath);
    expect(after).toEqual(before);
  });

  it("⑤ switching to a deck that was just created leaves the previously open deck's file unchanged", async () => {
    const a = await createDeck("deck-a");
    const server = await serve({ presentationId: a.id });
    const beforeSlidraFile = await fingerprintFile(a.slidraPath);

    // Created only now, after the server (and A) already exist — the exact
    // "just created" shape AC5 names.
    const b = await createDeck("deck-b-fresh");

    const response = await switchTo(server, b.id);
    expect(response.status).toBe(200);

    expect(await fingerprintFile(a.slidraPath)).toBe(beforeSlidraFile);
  });

  it("⑥ after switching, a command, a live event-stream update, and an undo all act on B — never on A", async () => {
    const a = await createDeck("deck-a");
    const b = await createDeck("deck-b");
    const server = await serve({ presentationId: a.id });
    const aBefore = await readSlide(a.id);

    const frameReader = await connectEvents(server);

    const switchResponse = await switchTo(server, b.id);
    expect(switchResponse.status).toBe(200);
    // Fixed broadcast order (NOOP-433 §3): deck-changed, presentation-changed,
    // save-state, all on the one already-open /api/events connection.
    expect(eventNameOf(await frameReader.readFrame())).toBe("deck-changed");
    expect(eventNameOf(await frameReader.readFrame())).toBe("presentation-changed");
    expect(eventNameOf(await frameReader.readFrame())).toBe("save-state");

    const command = await postJson(server, "/api/command", {
      name: "slide notes set",
      input: { slidePath: "slides/001.svg", text: "acts-on-b" },
    });
    expect(command.status).toBe(200);
    expect(eventNameOf(await frameReader.readFrame())).toBe("presentation-changed");
    expect(await readSlide(b.id)).toContain("acts-on-b");
    expect(await readSlide(a.id)).toBe(aBefore);

    const undo = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect(await readSlide(b.id)).not.toContain("acts-on-b");
    expect(await readSlide(a.id)).toBe(aBefore);
  });

  it("⑦ after switching, an agent message's session cwd and editorial brief point at B, not A", async () => {
    const a = await createDeck("deck-a");
    const b = await createDeck("deck-b");
    const logPath = path.join(slidraDir, "fake-agent.log.jsonl");
    const fakeAgent: AgentAdapterConfig = {
      kind: "claude",
      label: "Claude Code",
      command: process.execPath,
      args: [fakeAgentFixture],
      env: { FAKE_AGENT_CONFIG: JSON.stringify({ replies: [["ack"]] }), FAKE_AGENT_LOG: logPath },
    };
    const server = await serve({ presentationId: a.id, agent: fakeAgent });

    const switchResponse = await switchTo(server, b.id);
    expect(switchResponse.status).toBe(200);

    const chat = await postJson(server, "/api/chat", { text: "hi" });
    expect(chat.status).toBe(202);

    const log = await waitForLogLine(logPath, (entry) => entry.newSessionCwd !== undefined);
    const newSessionEntry = log.find((entry) => entry.newSessionCwd !== undefined)!;
    const bAgentWorkdir = path.join(resolveSlidraHome(), "agent", b.id);
    expect(newSessionEntry.newSessionCwd).toBe(await realWorkdir(bAgentWorkdir));

    const promptEntry = log.find((entry) => Array.isArray(entry.prompt));
    expect(promptEntry).toBeDefined();
    expect(JSON.stringify(promptEntry!.prompt)).toContain(b.id);
    expect(JSON.stringify(promptEntry!.prompt)).not.toContain(a.id);
  });
});

/** `deployAgentWorkdir` hands the agent a `realpath`'d cwd (symlink resolution) — the fixture's own log records exactly what it received, so this mirrors that with the same `realpath` used at deploy time. */
async function realWorkdir(target: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(target);
}

/** Polls the fake agent's log file (JSONL, one object appended per line) until a line matching `predicate` appears. */
async function waitForLogLine(
  logPath: string,
  predicate: (entry: { newSessionCwd?: string; prompt?: unknown[] }) => boolean,
  timeoutMs = 5000,
): Promise<Array<{ newSessionCwd?: string; prompt?: unknown[] }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let raw = "";
    try {
      raw = await readFile(logPath, "utf8");
    } catch {
      // Not written yet.
    }
    const lines = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { newSessionCwd?: string; prompt?: unknown[] });
    if (lines.some(predicate)) return lines;
    if (Date.now() > deadline) throw new Error(`timed out waiting for a log line matching the predicate in ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the deck-switch hook (AC6, pure unit — no HTTP, no CLI)", () => {
  function fakeIdentity(id: string): DeckIdentity {
    return { id, name: id, sourcePath: null };
  }

  it("⑧ fires exactly once per switch, with the outgoing deck's identity", async () => {
    const calls: DeckIdentity[] = [];
    const session = createDeckSession({
      initial: fakeIdentity("a"),
      resolveDeck: async (id) => fakeIdentity(id),
      unbind: async () => {},
      bind: async () => {},
      guard: () => null,
    });
    session.onDeckSwitch((outgoing) => {
      calls.push(outgoing);
    });

    const result = await session.switchTo("b");

    expect(result).toEqual({ deck: fakeIdentity("b"), switched: true });
    expect(calls).toEqual([fakeIdentity("a")]);
  });

  it("⑨ does not fire for a same-id switch, for entering from no-deck, or for an unknown id", async () => {
    let calls = 0;
    const session = createDeckSession({
      initial: null,
      resolveDeck: async (id) => {
        if (id === "missing") throw new Error("no presentation found for id: missing");
        return fakeIdentity(id);
      },
      unbind: async () => {},
      bind: async () => {},
      guard: () => null,
    });
    session.onDeckSwitch(() => {
      calls++;
    });

    // Entering from "no deck" — no outgoing identity to report.
    const first = await session.switchTo("a");
    expect(first).toEqual({ deck: fakeIdentity("a"), switched: true });
    expect(calls).toBe(0);

    // Same id as current — no rebind, no hook.
    const second = await session.switchTo("a");
    expect(second).toEqual({ deck: fakeIdentity("a"), switched: false });
    expect(calls).toBe(0);

    // Unknown id — resolveDeck rejects before anything unbinds.
    await expect(session.switchTo("missing")).rejects.toThrow("no presentation found for id: missing");
    expect(calls).toBe(0);
    expect(session.current()).toEqual(fakeIdentity("a"));
  });

  it("listener failures are logged, never veto or repeat the switch", async () => {
    const errorSpy: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(String(args[0]));
    };
    try {
      const session = createDeckSession({
        initial: fakeIdentity("a"),
        resolveDeck: async (id) => fakeIdentity(id),
        unbind: async () => {},
        bind: async () => {},
        guard: () => null,
      });
      let calls = 0;
      session.onDeckSwitch(() => {
        calls++;
        throw new Error("listener exploded");
      });

      const result = await session.switchTo("b");

      expect(result).toEqual({ deck: fakeIdentity("b"), switched: true });
      expect(calls).toBe(1);
      expect(errorSpy).toContain("listener exploded");
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("switch conflicts (AC/§4's guard table, pure unit for determinism)", () => {
  function fakeIdentity(id: string): DeckIdentity {
    return { id, name: id, sourcePath: null };
  }

  it("⑩ a switch already in progress refuses a second one with reason \"switching\", deterministically (no real-clock race)", async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const session = createDeckSession({
      initial: fakeIdentity("a"),
      resolveDeck: async (id) => {
        if (id === "b") await gate; // held open until the test releases it
        return fakeIdentity(id);
      },
      unbind: async () => {},
      bind: async () => {},
      guard: () => null,
    });

    const firstSwitch = session.switchTo("b");
    // `switchTo` sets its internal "switching" flag synchronously, before
    // its first await (deck-switch.ts's own docstring) — by the time this
    // line runs, the first call has already reserved the slot.
    await expect(session.switchTo("c")).rejects.toSatisfy(
      (error: unknown) => error instanceof DeckSwitchConflictError && error.reason === "switching",
    );

    releaseFirst!();
    const result = await firstSwitch;
    expect(result).toEqual({ deck: fakeIdentity("b"), switched: true });
  });

  it("⑩ guard() conflicts (editing floor held, export running) surface as 409-shaped errors with the guard's own reason/message", async () => {
    const session = createDeckSession({
      initial: fakeIdentity("a"),
      resolveDeck: async (id) => fakeIdentity(id),
      unbind: async () => {},
      bind: async () => {},
      guard: () => ({ reason: "editing", message: "The agent is currently editing, please wait." }),
    });

    await expect(session.switchTo("b")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof DeckSwitchConflictError &&
        error.reason === "editing" &&
        error.message === "The agent is currently editing, please wait.",
    );
    // Refused before resolveDeck/unbind ever ran — current is untouched.
    expect(session.current()).toEqual(fakeIdentity("a"));

    const exportingSession = createDeckSession({
      initial: fakeIdentity("a"),
      resolveDeck: async (id) => fakeIdentity(id),
      unbind: async () => {},
      bind: async () => {},
      guard: () => ({ reason: "exporting", message: "An export job is already in progress" }),
    });
    await expect(exportingSession.switchTo("b")).rejects.toSatisfy(
      (error: unknown) => error instanceof DeckSwitchConflictError && error.reason === "exporting",
    );
  });

  it("⑩ integration: serve.ts's real EditingLock/ExportJobManager wiring produces the same 409s over HTTP", async () => {
    const a = await createDeck("deck-a");
    const b = await createDeck("deck-b");
    const server = await serve({ presentationId: a.id });

    const beginLease = await fetch(`${server.url}/api/editing/begin`, { method: "POST" });
    expect(beginLease.status).toBe(200);
    const duringEditing = await switchTo(server, b.id);
    expect(duringEditing.status).toBe(409);
    expect((await duringEditing.json()).reason).toBe("editing");
    await fetch(`${server.url}/api/editing/end`, { method: "POST" });

    const exportStart = await postJson(server, "/api/export", { format: "pdf" });
    expect(exportStart.status).toBe(202);
    const duringExport = await switchTo(server, b.id);
    expect(duringExport.status).toBe(409);
    expect((await duringExport.json()).reason).toBe("exporting");
  });
});

describe("POST /api/deck/switch body contract (AC/§4's table)", () => {
  it("⑪ malformed/missing/wrongly-typed body -> 400; unknown id -> 404, A stays fully served", async () => {
    const a = await createDeck("deck-a");
    const server = await serve({ presentationId: a.id });

    const notJson = await fetch(`${server.url}/api/deck/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toBe("Request body is not valid JSON");

    for (const body of [{}, { id: "" }, { id: 123 }]) {
      const response = await postJson(server, "/api/deck/switch", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).error, JSON.stringify(body)).toBe("id must be a non-empty string");
    }

    const unknown = await switchTo(server, "not-a-real-presentation-id");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toContain("no presentation found for id: not-a-real-presentation-id");

    // A is still exactly what it was — none of the above ever unbound it.
    const deckGet = await fetch(`${server.url}/api/deck`);
    expect((await deckGet.json()).deck.id).toBe(a.id);
  });
});
