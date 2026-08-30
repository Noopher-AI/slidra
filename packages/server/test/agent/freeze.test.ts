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

// T5 (NOOP-93/#110): the agent-turn/undo-group/freeze contract, driven over
// HTTP with a real subprocess fake ACP agent — same Seam B discipline as
// chat.test.ts, never the real Claude Code/Codex, never a mock of
// AgentChatSession or history.ts itself.

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/multi-command-fake-acp-agent.mjs",
);

let coMotionHome: string;
let comotDir: string;
let logDir: string;
let logPath: string;
let registry: CommandRegistry;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-freeze-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-freeze-files-"));
  logDir = await mkdtemp(path.join(tmpdir(), "co-motion-freeze-log-"));
  logPath = path.join(logDir, "fake-agent.log.jsonl");
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
  await rm(logDir, { recursive: true, force: true });
});

async function openFreshPresentationWithElement(): Promise<{ id: string; elementId: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const slide = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  const match = /<text id="(el-[^"]+)"/.exec(slide.data!.content);
  if (!match) throw new Error("test fixture: title element id not found");
  return { id, elementId: match[1] };
}

function fakeAgent(scenario: Record<string, unknown>): AgentAdapterConfig {
  return {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [fixturePath],
    env: { FAKE_AGENT_CONFIG: JSON.stringify(scenario), FAKE_AGENT_LOG: logPath },
  };
}

async function serve(agent: AgentAdapterConfig, presentationId: string): Promise<RunningServer> {
  const server = await startServe({ registry, presentationId, port: 0, agent });
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

interface LogLine {
  pid?: number;
  turn?: number;
  permissionOutcome?: { outcome: string; optionId?: string };
  ranCommand?: string;
  readOnly?: boolean;
}

async function readLog(): Promise<LogLine[]> {
  if (!existsSync(logPath)) return [];
  const raw = await readFile(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** Polls the fake agent's log until `predicate` matches a line, or `timeoutMs` elapses. */
async function waitForLog(predicate: (line: LogLine) => boolean, timeoutMs = 5000): Promise<LogLine> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await readLog();
    const found = lines.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a matching log line; saw: ${JSON.stringify(lines)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function getEditingState(server: RunningServer): Promise<{ frozen: boolean }> {
  const response = await fetch(`${server.url}/api/editing`);
  return (await response.json()) as { frozen: boolean };
}

/** Polls GET /api/editing until `frozen` matches. */
async function waitForFrozen(server: RunningServer, frozen: boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getEditingState(server);
    if (state.frozen === frozen) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for frozen === ${frozen}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readSlide(id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

describe("T5: agent-turn undo grouping and editing freeze", () => {
  it("AC1: one turn's several commands undo together as a single group, and a second undo hits the empty stack", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const originalContent = await readSlide(id);
    const commands = [
      `co-motion text set ${id} slides/001.svg ${elementId} '第一次'`,
      `co-motion text set ${id} slides/001.svg ${elementId} '第二次'`,
      `co-motion text set ${id} slides/001.svg ${elementId} '第三次'`,
    ];
    const server = await serve(fakeAgent({ commandsPerTurn: [commands] }), id);

    const chatResponse = await postChat(server, "改三次標題");
    expect(chatResponse.status).toBe(202);
    await waitForLog((line) => line.ranCommand === commands[2]);
    await waitForFrozen(server, false);

    const editedContent = await readSlide(id);
    expect(editedContent).toContain("第三次");
    expect(editedContent).not.toBe(originalContent);

    const undoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(undoResponse.status).toBe(200);
    const restoredContent = await readSlide(id);
    expect(restoredContent).toBe(originalContent);

    const secondUndoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(secondUndoResponse.status).toBe(400);
    const body = (await secondUndoResponse.json()) as { error: string };
    expect(body.error).toBe("沒有可復原的操作");
  });

  it("AC2-a: after the turn, stack.json has no open group and exactly one undo entry for it", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const commands = [
      `co-motion text set ${id} slides/001.svg ${elementId} 'A'`,
      `co-motion text set ${id} slides/001.svg ${elementId} 'B'`,
    ];
    const server = await serve(fakeAgent({ commandsPerTurn: [commands] }), id);

    await postChat(server, "改標題");
    await waitForLog((line) => line.ranCommand === commands[1]);
    await waitForFrozen(server, false);

    const stackRaw = await readFile(path.join(coMotionHome, "history", id, "stack.json"), "utf8");
    const stack = JSON.parse(stackRaw) as { undo: unknown[]; openGroup: unknown | null };
    expect(stack.openGroup).toBeNull();
    expect(stack.undo).toHaveLength(1);
  });

  it("two separate agent turns produce two separate undo groups", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const cmd1 = `co-motion text set ${id} slides/001.svg ${elementId} '回合一'`;
    const cmd2 = `co-motion text set ${id} slides/001.svg ${elementId} '回合二'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[cmd1], [cmd2]] }), id);

    await postChat(server, "第一次請求");
    await waitForLog((line) => line.ranCommand === cmd1);
    await waitForFrozen(server, false);

    await postChat(server, "第二次請求");
    await waitForLog((line) => line.ranCommand === cmd2);
    await waitForFrozen(server, false);

    const stackRaw = await readFile(path.join(coMotionHome, "history", id, "stack.json"), "utf8");
    const stack = JSON.parse(stackRaw) as { undo: unknown[] };
    expect(stack.undo).toHaveLength(2);
  });

  it("AC2-b: a turn that only reads (thinks) never freezes, and undo requests during it are never 409'd", async () => {
    const { id } = await openFreshPresentationWithElement();
    const server = await serve(fakeAgent({ commandsPerTurn: [], readOnlyTurns: [0] }), id);

    await postChat(server, "先看看投影片");
    await waitForLog((line) => line.readOnly === true);

    // The turn has read the file but is still technically "in flight"
    // (chat-done has not necessarily fired the instant the log line lands)
    // — frozen must be false throughout, never having flipped true at all.
    expect((await getEditingState(server)).frozen).toBe(false);
    const undoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
    // 400 (empty stack), not 409 (would mean the request was refused for
    // being frozen) — proves this route was never blocked by the lock.
    expect(undoResponse.status).toBe(400);
  });

  it("AC2-c: undo is refused (409) from the first command until the turn ends, then allowed", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const command = `co-motion text set ${id} slides/001.svg ${elementId} '改一次'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    await postChat(server, "改標題");
    await waitForLog((line) => line.permissionOutcome !== undefined);

    expect((await getEditingState(server)).frozen).toBe(true);
    const duringTurn = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(duringTurn.status).toBe(409);
    const duringBody = (await duringTurn.json()) as { error: string };
    expect(duringBody.error).toBe("agent 正在編輯中，請稍候");

    await waitForFrozen(server, false);
    const afterTurn = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(afterTurn.status).toBe(200);
  });

  it("AC4: the agent's first command waits for an in-progress human edit instead of failing", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const originalContent = await readSlide(id);
    const command = `co-motion text set ${id} slides/001.svg ${elementId} '人放手後才改'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    const beginResponse = await fetch(`${server.url}/api/editing/begin`, { method: "POST" });
    expect(beginResponse.status).toBe(200);

    await postChat(server, "改標題");
    // Give the agent's first requestPermission call a chance to reach the
    // server and start waiting — long enough that, were it (wrongly) to
    // fail fast instead of waiting, the permissionOutcome/error would
    // already be logged.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await readLog()).some((line) => line.permissionOutcome !== undefined)).toBe(false);
    expect(await readSlide(id)).toBe(originalContent);

    const endResponse = await fetch(`${server.url}/api/editing/end`, { method: "POST" });
    expect(endResponse.status).toBe(200);

    const permissionLine = await waitForLog((line) => line.permissionOutcome !== undefined);
    expect(permissionLine.permissionOutcome).toEqual({ outcome: "selected", optionId: "allow" });
    await waitForLog((line) => line.ranCommand === command);
    expect(await readSlide(id)).toContain("人放手後才改");
  });

  it("POST /api/editing/begin is refused with 409 while the agent holds the floor", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const command = `co-motion text set ${id} slides/001.svg ${elementId} '改標題'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    await postChat(server, "改標題");
    await waitForLog((line) => line.permissionOutcome !== undefined);

    const beginResponse = await fetch(`${server.url}/api/editing/begin`, { method: "POST" });
    expect(beginResponse.status).toBe(409);

    await waitForFrozen(server, false);
  });

  it("POST /api/editing/end is idempotent — a redundant end is not an error", async () => {
    const { id } = await openFreshPresentationWithElement();
    const server = await serve(fakeAgent({ commandsPerTurn: [] }), id);
    const response = await fetch(`${server.url}/api/editing/end`, { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("POST /api/command: T2's four whitelisted commands are all refused with 409 while the agent holds the floor, then allowed once it releases", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const command = `co-motion text set ${id} slides/001.svg ${elementId} '改標題'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    await postChat(server, "改標題");
    await waitForLog((line) => line.permissionOutcome !== undefined);
    expect((await getEditingState(server)).frozen).toBe(true);

    for (const name of ["element move", "element scale", "element rotate", "textbox width"]) {
      const response = await fetch(`${server.url}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, input: { slidePath: "slides/001.svg" } }),
      });
      expect(response.status, `${name} 應該在凍結期間被擋下`).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("agent 正在編輯中，請稍候");
    }

    await waitForFrozen(server, false);

    // Once the turn releases the lock, the gate itself must stop refusing —
    // proven the same way the whitelist test above proves the opposite
    // (never 403 there, never 409 here). Whether the command's own input
    // is well-formed enough to actually run is a separate concern already
    // covered by command-endpoint.test.ts.
    for (const name of ["element move", "element scale", "element rotate", "textbox width"]) {
      const response = await fetch(`${server.url}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, input: { slidePath: "slides/001.svg" } }),
      });
      expect(response.status, `${name} 解凍後不應該再被閘門擋下`).not.toBe(409);
    }
  });

  it("browsing endpoints are unaffected while frozen: GET /api/presentation and GET /api/files/* keep working", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const command = `co-motion text set ${id} slides/001.svg ${elementId} '改標題'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    await postChat(server, "改標題");
    await waitForLog((line) => line.permissionOutcome !== undefined);
    expect((await getEditingState(server)).frozen).toBe(true);

    const presentationResponse = await fetch(`${server.url}/api/presentation`);
    expect(presentationResponse.status).toBe(200);
    const fileResponse = await fetch(`${server.url}/api/files/${encodeURIComponent("slides/001.svg")}`);
    expect(fileResponse.status).toBe(200);

    await waitForFrozen(server, false);
  });
});
