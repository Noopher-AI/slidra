import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../../src/serve.js";
import type { RunningServer } from "../../src/serve.js";
import type { AgentAdapterConfig } from "../../src/agent/session.js";
import { EDITORIAL_BRIEF } from "../../src/agent/brief.js";

// Seam B (issue #1): start the real server, drive it over HTTP, with a
// scripted fake ACP agent — a real subprocess speaking ACP over stdio,
// never the real Claude Code or Codex — as the counterparty.

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.mjs",
);

let coMotionHome: string;
let comotDir: string;
let logDir: string;
let logPath: string;
let registry: CommandRegistry;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-chat-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-chat-files-"));
  logDir = await mkdtemp(path.join(tmpdir(), "co-motion-chat-log-"));
  logPath = path.join(logDir, "fake-agent.log.jsonl");
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
});

afterEach(async () => {
  // Every server (and with it, the adapter subprocess and any open SSE
  // stream) is torn down here, including on assertion failure, or the
  // suite hangs on a live child process / open socket.
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
  await rm(logDir, { recursive: true, force: true });
});

async function openFreshPresentation(): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

/** Builds an AgentAdapterConfig that spawns the fake ACP agent fixture, scripted per test. */
function fakeAgent(scenario: Record<string, unknown>): AgentAdapterConfig {
  return {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [fixturePath],
    env: { FAKE_AGENT_CONFIG: JSON.stringify(scenario), FAKE_AGENT_LOG: logPath },
  };
}

async function serve(agent: AgentAdapterConfig): Promise<RunningServer> {
  const id = await openFreshPresentation();
  const server = await startServe({ registry, presentationId: id, port: 0, agent });
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

async function readFakeAgentLog(): Promise<
  Array<{
    sessionId?: string;
    prompt?: unknown[];
    permissionOutcome?: unknown;
    newSessionCwd?: string;
    pid?: number;
  }>
> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** `process.kill(pid, 0)` sends no signal — it only checks the process still exists (POSIX). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `check` until it returns true or `timeoutMs` elapses, so a test never races an async process exit. */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Narrows the fake agent's log to only the `session/prompt` entries, in
 * order. The log also carries one `pid` line per spawn and one
 * `newSessionCwd` line per `session/new` call (fixes 1 and 4's own tests
 * use those); prompt-shape assertions must filter those out rather than
 * assume fixed indices.
 */
function promptEntries(
  log: Awaited<ReturnType<typeof readFakeAgentLog>>,
): Array<{ sessionId: string; prompt: unknown[] }> {
  return log.filter((entry): entry is { sessionId: string; prompt: unknown[] } => entry.prompt !== undefined);
}

/**
 * Reads SSE frames off one fetch Response body, one `getReader()` for the
 * whole connection's lifetime — a `Response.body` can only ever be locked
 * by a single reader, so a test that sends several messages over the same
 * stream must reuse this reader across calls rather than re-acquiring one
 * per read. Frame parsing (accumulate to the blank line) follows
 * sse.test.ts's helper — the one part of that suite worth copying;
 * everything else about it (its hang-prone afterEach, its race-y
 * validation tests) is deliberately not reused here.
 */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  /** Reads forward until `predicate` matches an event (inclusive), returning every event seen since the reader was created. */
  async readUntil(
    predicate: (event: { event: string; data: unknown }) => boolean,
  ): Promise<Array<{ event: string; data: unknown }>> {
    const events: Array<{ event: string; data: unknown }> = [];
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.buffer += this.decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const lines = frame.split("\n").filter((line) => line && !line.startsWith(":"));
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (eventLine && dataLine) {
          const parsed = { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
          events.push(parsed);
          if (predicate(parsed)) return events;
        }
      }
    }
    return events;
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

describe("chat: the 編輯規約 and prompt shape", () => {
  it("sends the 編輯規約 as the very first session/prompt, as a one-text-block content array", async () => {
    const server = await serve(fakeAgent({ replies: [["(ack)"], ["好的"]] }));
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const done = sse.readUntil((e) => e.event === "chat-done");
    const response = await postChat(server, "把標題改成 Q3 財報");
    expect(response.status).toBe(202);
    await done;
    await sse.close();

    const prompts = promptEntries(await readFakeAgentLog());
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0].prompt).toEqual([{ type: "text", text: EDITORIAL_BRIEF }]);
    expect(prompts[1].prompt).toEqual([{ type: "text", text: "把標題改成 Q3 財報" }]);
  });

  it("reuses the same sessionId across two separate messages", async () => {
    const server = await serve(fakeAgent({ replies: [["(ack)"], ["第一則回覆"], ["第二則回覆"]] }));
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    await postChat(server, "第一則訊息");
    await sse.readUntil((e) => e.event === "chat-done");

    await postChat(server, "第二則訊息");
    await sse.readUntil((e) => e.event === "chat-done");
    await sse.close();

    const prompts = promptEntries(await readFakeAgentLog());
    expect(prompts).toHaveLength(3); // 編輯規約 + 2 user messages
    const sessionIds = new Set(prompts.map((entry) => entry.sessionId));
    expect(sessionIds.size).toBe(1);
  });
});

describe("chat: reply streaming", () => {
  it("streams reply chunks to the client as chat-chunk events, and only for the author's own turn", async () => {
    const server = await serve(
      fakeAgent({ replies: [["編輯規約收到，這句話絕不該讓作者看到"], ["Q3", " 財報", " 已更新"]] }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const events = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "把標題改成 Q3 財報");
    const collected = await events;
    await sse.close();

    const chunkTexts = collected.filter((e) => e.event === "chat-chunk").map((e) => (e.data as { text: string }).text);
    expect(chunkTexts).toEqual(["Q3", " 財報", " 已更新"]);
    // The brief-turn's own reply never reached the client.
    expect(chunkTexts.join("")).not.toContain("編輯規約收到");

    const done = collected.find((e) => e.event === "chat-done");
    expect((done!.data as { stopReason: string }).stopReason).toBe("end_turn");
  });
});

describe("chat: not logged in", () => {
  it("surfaces a clear login prompt naming the agent, with no degraded fallback", async () => {
    const server = await serve(fakeAgent({ authRequired: true }));
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const events = sse.readUntil((e) => e.event === "chat-error");
    await postChat(server, "你好");
    const collected = await events;
    await sse.close();

    const errorEvent = collected.find((e) => e.event === "chat-error");
    expect(errorEvent).toBeDefined();
    const message = (errorEvent!.data as { message: string }).message;
    expect(message).toContain("Claude Code");
    expect(message).toMatch(/登入/);
  });
});

describe("chat: permission requests are refused, not allow-listed", () => {
  it("responds to the fake agent's permission request with a refusal", async () => {
    const server = await serve(
      fakeAgent({ replies: [["(ack)"], ["好的"]], requestPermissionOnPromptIndex: 1 }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "幫我執行一個工具");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const permissionEntry = log.find((entry) => "permissionOutcome" in entry);
    expect(permissionEntry?.permissionOutcome).toEqual({ outcome: "cancelled" });
  });
});

describe("chat: HTTP method gate", () => {
  it("routes POST /api/chat, and leaves every other method/path exactly as before", async () => {
    const server = await serve(fakeAgent({ replies: [["(ack)"]] }));

    const chatPost = await postChat(server, "你好");
    expect(chatPost.status).toBe(202);

    const otherPost = await fetch(`${server.url}/api/presentation`, { method: "POST" });
    expect(otherPost.status).toBe(405);
    expect((await otherPost.json()).error).toBe("只支援 GET");

    const chatDelete = await fetch(`${server.url}/api/chat`, { method: "DELETE" });
    expect(chatDelete.status).toBe(405);
    expect((await chatDelete.json()).error).toBe("只支援 GET");

    const stillGet = await fetch(`${server.url}/api/presentation`);
    expect(stillGet.status).toBe(200);
  });
});

describe("chat: shutdown does not hang on an open stream", () => {
  it("closes a live /api/chat/stream connection so close() resolves instead of hanging", async () => {
    const server = await serve(fakeAgent({ replies: [["(ack)"]] }));
    // A real, still-open client connection — the exact shape "someone left
    // a browser tab open" takes. server.close() (Node's http.Server.close)
    // waits for established connections rather than closing them, and an
    // SSE stream never ends on its own, so before the fix this hung
    // forever.
    const stream = await fetch(`${server.url}/api/chat/stream`);
    expect(stream.status).toBe(200);

    // Remove this server from the shared `servers` array so afterEach does
    // not also try to close it — this test owns the close/assert itself.
    servers = servers.filter((running) => running !== server);

    // Races close() against a short timeout so a regression fails with a
    // clear message instead of just eating the whole test-suite timeout.
    const timedOut = Symbol("timed out");
    const result = await Promise.race([
      server.close().then(() => "closed" as const),
      new Promise((resolve) => setTimeout(() => resolve(timedOut), 3000)),
    ]);
    expect(result).toBe("closed");

    await stream.body?.cancel().catch(() => {});
  });
});

describe("chat: session cwd", () => {
  it("hands the agent a fresh empty temp directory, never the real process cwd or a path under CO_MOTION_HOME", async () => {
    const server = await serve(fakeAgent({ replies: [["(ack)"]] }));
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "你好");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const newSessionEntry = log.find((entry) => entry.newSessionCwd !== undefined);
    expect(newSessionEntry).toBeDefined();
    const sentCwd = newSessionEntry!.newSessionCwd!;

    // Never the real project directory the CLI was launched from.
    expect(sentCwd).not.toBe(process.cwd());
    // Never anywhere under CO_MOTION_HOME — that would disclose where the
    // home is, and `..` from there reaches `work/<id>`, the presentation's
    // real work directory (ADR-0004).
    const relativeToHome = path.relative(coMotionHome, sentCwd);
    expect(relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)).toBe(true);
  });
});

describe("chat: a failed start must not leak its subprocess", () => {
  it("tears down the failed attempt's child so a retry leaves exactly one live child process", async () => {
    const markerDir = await mkdtemp(path.join(tmpdir(), "co-motion-chat-marker-"));
    const markerPath = path.join(markerDir, "attempted");
    try {
      const server = await serve(
        fakeAgent({ replies: [["(ack)"], ["好的"]], failFirstAttemptMarkerPath: markerPath }),
      );
      const stream = await fetch(`${server.url}/api/chat/stream`);
      const sse = new SseReader(stream);

      // First attempt: the fake agent fails newSession (scripted via the
      // marker file), simulating the not-logged-in path.
      const firstError = sse.readUntil((e) => e.event === "chat-error");
      await postChat(server, "第一次嘗試");
      await firstError;

      // Second attempt: a fresh subprocess spawn, this time succeeding.
      const secondDone = sse.readUntil((e) => e.event === "chat-done");
      await postChat(server, "第二次嘗試");
      await secondDone;
      await sse.close();

      const log = await readFakeAgentLog();
      const pids = log.filter((entry) => entry.pid !== undefined).map((entry) => entry.pid!);
      expect(pids).toHaveLength(2);
      const [firstPid, secondPid] = pids;

      // Before the fix, the first (failed) child was never killed — only
      // `dispose()`'s `this.child` (by then overwritten to the second
      // child) ever got a kill signal, so the first child leaked forever.
      await waitFor(() => !isAlive(firstPid));
      expect(isAlive(firstPid)).toBe(false);
      expect(isAlive(secondPid)).toBe(true);
    } finally {
      await rm(markerDir, { recursive: true, force: true });
    }
  });
});
