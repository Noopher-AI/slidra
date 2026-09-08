import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../../src/serve.js";
import type { RunningServer } from "../../src/serve.js";
import type { AgentAdapterConfig } from "../../src/agent/session.js";
import type { AgentKind } from "../../src/agent/adapters.js";
import type { AgentSource } from "../../src/agent/manager.js";
import type { CommandOutcome, CommandRunner } from "../../src/agent/probe.js";
import { buildEditorialBrief } from "../../src/agent/brief.js";
import { agentSettingsPath } from "../../src/agent/settings.js";

// HTTP boundary (§6.2): routing, status codes, SSE broadcast, and real
// session switching — driven against a real `startServe`, real fake-ACP
// subprocess fixtures, never a mock of AgentManager/AgentChatSession/
// EditingLock. Login status is fully controlled via `agentManager.runCommand`
// injection (probe.ts's seam) — no real `claude`/`codex` CLI is ever
// consulted here.

const singleCommandFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.mjs",
);
const multiCommandFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/multi-command-fake-acp-agent.mjs",
);

let coMotionHome: string;
let comotDir: string;
let logDir: string;
let logPath: string;
let registry: CommandRegistry;
let servers: RunningServer[];
let streams: Array<{ cancel: () => Promise<void> }>;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-agentapi-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-agentapi-files-"));
  logDir = await mkdtemp(path.join(tmpdir(), "co-motion-agentapi-log-"));
  logPath = path.join(logDir, "fake-agent.log.jsonl");
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
  streams = [];
});

afterEach(async () => {
  await Promise.all(streams.map((stream) => stream.cancel()));
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(logDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function openFreshPresentation(): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

/** A single-command fake ACP adapter config, shared log across kinds so A8/A9 can observe spawn order across a switch. */
function fixtureAdapter(kind: AgentKind, fixture: string, scenario: Record<string, unknown> = {}): AgentAdapterConfig {
  return {
    kind,
    label: kind === "claude" ? "Claude Code" : "Codex",
    command: process.execPath,
    args: [fixture],
    env: { FAKE_AGENT_CONFIG: JSON.stringify(scenario), FAKE_AGENT_LOG: logPath },
  };
}

/** Both kinds resolve to the given fixture/scenario — a switch changes *which session*, not which fixture code runs. */
function resolveBothTo(fixture: string, scenario: Record<string, unknown> = {}): (kind: AgentKind) => AgentAdapterConfig {
  return (kind) => fixtureAdapter(kind, fixture, scenario);
}

const outcome = (partial: Partial<CommandOutcome> = {}): CommandOutcome => ({ code: 0, stdout: "", stderr: "", ...partial });

/** Controls both cards' probed login status without ever spawning a real `claude`/`codex`. */
function loginStatusRunner(status: {
  claude?: CommandOutcome;
  codex?: CommandOutcome;
}): CommandRunner {
  return async (command) => {
    if (command === "claude") return status.claude ?? outcome({ stdout: '{"loggedIn":true}' });
    if (command === "codex") return status.codex ?? outcome();
    throw new Error(`unexpected probe command in test: ${command}`);
  };
}

const bothAvailable = loginStatusRunner({});

interface ServeInit {
  presentationId: string;
  initialAgent?: { kind: AgentKind | null; source: AgentSource };
  runCommand?: CommandRunner;
  resolveAdapter?: (kind: AgentKind) => AgentAdapterConfig;
}

async function serve(init: ServeInit): Promise<RunningServer> {
  const server = await startServe({
    registry,
    presentationId: init.presentationId,
    port: 0,
    initialAgent: init.initialAgent,
    agentManager: { runCommand: init.runCommand, resolveAdapter: init.resolveAdapter },
  });
  servers.push(server);
  return server;
}

async function postChat(server: RunningServer, text: string): Promise<Response> {
  return fetch(`${server.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function selectAgent(server: RunningServer, kind: AgentKind): Promise<Response> {
  return fetch(`${server.url}/api/agent/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
}

interface LogLine {
  pid?: number;
  sessionId?: string;
  prompt?: Array<{ type: string; text: string }>;
  permissionOutcome?: { outcome: string; optionId?: string };
  turn?: number;
  ranCommand?: string;
}

async function readLog(): Promise<LogLine[]> {
  if (!existsSync(logPath)) return [];
  const raw = await readFile(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

async function waitForLog(predicate: (line: LogLine) => boolean, timeoutMs = 10_000): Promise<LogLine> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await readLog();
    const found = lines.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a matching log line; saw: ${JSON.stringify(lines)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPidCount(count: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = (await readLog()).filter((line) => line.pid !== undefined).map((line) => line.pid!);
    if (pids.length >= count) return pids;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} pid(s); saw: ${JSON.stringify(pids)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits until at least `count` `session/prompt` calls have been logged (across however many sessions). */
async function waitForPromptCount(count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const prompts = (await readLog()).filter((line) => line.prompt !== undefined);
    if (prompts.length >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} prompt(s); saw ${prompts.length}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function getEditingState(server: RunningServer): Promise<{ frozen: boolean }> {
  const response = await fetch(`${server.url}/api/editing`);
  return (await response.json()) as { frozen: boolean };
}

async function waitForFrozen(server: RunningServer, frozen: boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getEditingState(server);
    if (state.frozen === frozen) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for frozen === ${frozen}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

async function connectEvents(server: RunningServer) {
  const response = await fetch(`${server.url}/api/events`);
  const frameReader = createFrameReader(response);
  streams.push(frameReader);
  return frameReader;
}

describe("GET /api/agent", () => {
  it("A7/A10: reports both cards, each correctly available/unauthenticated, with their static login commands", async () => {
    const id = await openFreshPresentation();
    const server = await serve({
      presentationId: id,
      initialAgent: { kind: "claude", source: "cli" },
      runCommand: loginStatusRunner({
        claude: outcome({ stdout: '{"loggedIn":true}' }),
        codex: outcome({ code: 1, stdout: "Not logged in" }),
      }),
      resolveAdapter: resolveBothTo(singleCommandFixture),
    });

    const response = await fetch(`${server.url}/api/agent`);
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      current: string;
      source: string;
      agents: Array<{ kind: string; status: string; loginCommand: string; detail?: string }>;
    };
    expect(status.current).toBe("claude");
    expect(status.source).toBe("cli");
    const claudeCard = status.agents.find((agent) => agent.kind === "claude")!;
    const codexCard = status.agents.find((agent) => agent.kind === "codex")!;
    expect(claudeCard.status).toBe("available");
    expect(claudeCard.loginCommand).toBe("claude auth login");
    expect(codexCard.status).toBe("unauthenticated");
    expect(codexCard.loginCommand).toBe("codex login");
  });

  it("A7: a genuine probe failure (spawn error) surfaces as unauthenticated with a detail string", async () => {
    const id = await openFreshPresentation();
    const server = await serve({
      presentationId: id,
      initialAgent: { kind: "claude", source: "cli" },
      runCommand: loginStatusRunner({ claude: { code: null, stdout: "", stderr: "ENOENT: not found" } }),
      resolveAdapter: resolveBothTo(singleCommandFixture),
    });

    const status = (await (await fetch(`${server.url}/api/agent`)).json()) as {
      agents: Array<{ kind: string; status: string; detail?: string }>;
    };
    const claudeCard = status.agents.find((agent) => agent.kind === "claude")!;
    expect(claudeCard.status).toBe("unauthenticated");
    expect(claudeCard.detail).toContain("ENOENT");
  });

  it("current: null reports source: 'none'", async () => {
    const id = await openFreshPresentation();
    const server = await serve({
      presentationId: id,
      initialAgent: { kind: null, source: "none" },
      runCommand: bothAvailable,
    });

    const status = (await (await fetch(`${server.url}/api/agent`)).json()) as { current: null; source: string };
    expect(status.current).toBeNull();
    expect(status.source).toBe("none");
  });
});

describe("POST /api/agent/select", () => {
  it("A5: persists across a restart — select codex, close, reopen with the same CO_MOTION_HOME, GET /api/agent still reports codex/settings", async () => {
    const id = await openFreshPresentation();
    const server1 = await serve({
      presentationId: id,
      initialAgent: { kind: "claude", source: "cli" },
      runCommand: bothAvailable,
      resolveAdapter: resolveBothTo(singleCommandFixture),
    });

    const selectResponse = await selectAgent(server1, "codex");
    expect(selectResponse.status).toBe(200);
    await server1.close();
    servers = servers.filter((server) => server !== server1);

    const server2 = await serve({
      presentationId: id,
      // No initialAgent this time — production cli.ts would read settings.json itself;
      // this test reads it the same way to prove the persisted value round-trips.
      initialAgent: { kind: "codex", source: "settings" },
      runCommand: bothAvailable,
      resolveAdapter: resolveBothTo(singleCommandFixture),
    });

    const status = (await (await fetch(`${server2.url}/api/agent`)).json()) as { current: string; source: string };
    expect(status.current).toBe("codex");
    expect(status.source).toBe("settings");

    const settingsRaw = await readFile(agentSettingsPath(), "utf8");
    expect(JSON.parse(settingsRaw)).toEqual({ agent: "codex" });
  });

  it("rejects an invalid body", async () => {
    const id = await openFreshPresentation();
    const server = await serve({ presentationId: id, initialAgent: { kind: null, source: "none" }, runCommand: bothAvailable });

    const badJson = await fetch(`${server.url}/api/agent/select`, { method: "POST", body: "not json" });
    expect(badJson.status).toBe(400);

    const badKind = await selectAgent(server, "gemini" as unknown as AgentKind);
    expect(badKind.status).toBe(400);
    expect((await badKind.json()).error).toContain("claude");
  });

  it("A8: switching agents ends the old session's process and starts a new one whose first prompt is the 編輯規約", async () => {
    const id = await openFreshPresentation();
    const server = await serve({
      presentationId: id,
      initialAgent: { kind: "claude", source: "cli" },
      runCommand: bothAvailable,
      resolveAdapter: resolveBothTo(singleCommandFixture),
    });

    expect((await postChat(server, "第一則訊息")).status).toBe(202);
    const [firstPid] = await waitForPidCount(1);
    // Two session/prompt calls land for the first session: index 0 (編輯規約), index 1 (author's message).
    await waitForPromptCount(2);

    const selectResponse = await selectAgent(server, "codex");
    expect(selectResponse.status).toBe(200);
    const selectBody = (await selectResponse.json()) as { ok: boolean; current: string; source: string };
    expect(selectBody).toEqual({ ok: true, current: "codex", source: "settings" });

    expect((await postChat(server, "第二則訊息")).status).toBe(202);
    const pids = await waitForPidCount(2);
    const secondPid = pids[1];
    expect(secondPid).not.toBe(firstPid);
    // The new session's own handshake (its 編輯規約 prompt) happens after
    // its pid is logged — wait for it to actually land, or the read below
    // races the still-in-flight ACP handshake.
    await waitForPromptCount(3);

    expect(() => process.kill(firstPid, 0)).toThrow();

    // The new session's own first session/prompt call (its 編輯規約) is the
    // first `prompt` log entry logged *after* the second pid line.
    const lines = await readLog();
    const secondPidIndex = lines.findIndex((line) => line.pid === secondPid);
    const newSessionFirstPrompt = lines.slice(secondPidIndex + 1).find((line) => line.prompt !== undefined);
    expect(newSessionFirstPrompt?.prompt).toEqual([{
      type: "text", text: expect.stringContaining(buildEditorialBrief(id)),
    }]);
    expect(newSessionFirstPrompt?.prompt).toEqual([{
      type: "text", text: expect.stringContaining("sandbox_permissions=require_escalated"),
    }]);
  });

  it("A9: refused (409, reason 'editing') while the agent holds the floor; session unswapped", async () => {
    const id = await openFreshPresentation();
    const comotPath = path.join(comotDir, "extra.comot");
    // A separate presentation so `co-motion text set` has a real target
    // for the multi-command fixture's shell command.
    await registry.dispatch("new", { path: comotPath, name: "測試簡報二" });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const lockId = opened.data!.id;
    const slide = await registry.dispatch<{ content: string }>("cat", { id: lockId, path: "slides/001.svg" });
    const elementId = /<text id="(el-[^"]+)"/.exec(slide.data!.content)![1];
    const command = `co-motion text set ${lockId} slides/001.svg ${elementId} '改一次'`;

    const server = await serve({
      presentationId: lockId,
      initialAgent: { kind: "claude", source: "cli" },
      runCommand: bothAvailable,
      resolveAdapter: resolveBothTo(multiCommandFixture, { commandsPerTurn: [[command]] }),
    });

    expect((await postChat(server, "改標題")).status).toBe(202);
    await waitForLog((line) => line.permissionOutcome !== undefined);
    expect((await getEditingState(server)).frozen).toBe(true);

    const selectResponse = await selectAgent(server, "codex");
    expect(selectResponse.status).toBe(409);
    expect((await selectResponse.json()).reason).toBe("editing");

    await waitForFrozen(server, false);

    // Session was never swapped: a further message still goes to the same
    // (claude) session — no second pid ever appears.
    expect((await postChat(server, "確認還是同一個 session")).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pids = (await readLog()).filter((line) => line.pid !== undefined);
    expect(pids).toHaveLength(1);
  });
});

describe("POST /api/chat — agent gate (A11)", () => {
  it("current: null → 409 reason 'unset', kind null", async () => {
    const id = await openFreshPresentation();
    const server = await serve({ presentationId: id, initialAgent: { kind: null, source: "none" }, runCommand: bothAvailable });

    const response = await postChat(server, "hello");
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; reason: string; kind: null };
    expect(body.reason).toBe("unset");
    expect(body.kind).toBeNull();
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("current set but unauthenticated → 409 reason 'unauthenticated', kind claude", async () => {
    const id = await openFreshPresentation();
    const server = await serve({
      presentationId: id,
      initialAgent: { kind: "claude", source: "cli" },
      runCommand: loginStatusRunner({ claude: outcome({ stdout: '{"loggedIn":false}' }) }),
      resolveAdapter: resolveBothTo(singleCommandFixture),
    });

    const response = await postChat(server, "hello");
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; reason: string; kind: string };
    expect(body.reason).toBe("unauthenticated");
    expect(body.kind).toBe("claude");
    expect(body.error.length).toBeGreaterThan(0);
  });
});

describe("agent-changed event (A12)", () => {
  it("fires only when select() actually changes the kind, carrying { kind, label }", async () => {
    const id = await openFreshPresentation();
    const server = await serve({
      presentationId: id,
      initialAgent: { kind: "claude", source: "cli" },
      runCommand: bothAvailable,
      resolveAdapter: resolveBothTo(singleCommandFixture),
    });
    const frameReader = await connectEvents(server);

    // Same-kind select first — must NOT emit an event. `select()` broadcasts
    // synchronously (if at all) before its HTTP response is sent, so
    // `readFrame()` reads frames in emission order: were a same-kind select
    // to wrongly fire, it would be the *first* frame this test observes —
    // which the exact-payload assertion below (naming codex, not claude)
    // would then fail on. No separate timeout-based "and nothing arrived"
    // check is needed on top of that ordering guarantee.
    const sameKindResponse = await selectAgent(server, "claude");
    expect(sameKindResponse.status).toBe(200);

    const differentKindResponse = await selectAgent(server, "codex");
    expect(differentKindResponse.status).toBe(200);

    const frame = await frameReader.readFrame();
    expect(frame).toBe('event: agent-changed\ndata: {"kind":"codex","label":"Codex"}\n\n');
  });
});
