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

async function readFakeAgentLog(): Promise<Array<{ sessionId: string; prompt?: unknown[]; permissionOutcome?: unknown }>> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
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

    const log = await readFakeAgentLog();
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0].prompt).toEqual([{ type: "text", text: EDITORIAL_BRIEF }]);
    expect(log[1].prompt).toEqual([{ type: "text", text: "把標題改成 Q3 財報" }]);
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

    const log = await readFakeAgentLog();
    expect(log).toHaveLength(3); // 編輯規約 + 2 user messages
    const sessionIds = new Set(log.map((entry) => entry.sessionId));
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
