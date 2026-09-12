import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServe } from "../../src/serve.js";
import type { RunningServer } from "../../src/serve.js";
import type { AgentAdapterConfig } from "../../src/agent/session.js";
import { buildEditorialBrief } from "../../src/agent/brief.js";
import { buildCommentContext } from "../../src/agent/session.js";

const execFileAsync = promisify(execFile);
const slidraBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../target/release/slidra");

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

/** Reads a slide (or any text path) via `cat --json` and returns its decoded text — the same shape ACP's `fs/read_text_file` hands back. */
async function readPresentationTextViaCli(id: string, virtualPath: string): Promise<string> {
  const result = await runCli<Array<{ path: string; content: string }>>(["cat", id, virtualPath]);
  expect(result.ok).toBe(true);
  return Buffer.from(result.data![0]!.content, "base64").toString("utf-8");
}

// Seam B: start the real server, drive it over HTTP, with a
// scripted fake ACP agent — a real subprocess speaking ACP over stdio,
// never the real Claude Code or Codex — as the counterparty.

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.mjs",
);

let slidraHome: string;
let slidraDir: string;
let logDir: string;
let logPath: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-chat-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-chat-files-"));
  logDir = await mkdtemp(path.join(tmpdir(), "slidra-chat-log-"));
  logPath = path.join(logDir, "fake-agent.log.jsonl");
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
  servers = [];
});

afterEach(async () => {
  // Every server (and with it, the adapter subprocess and any open SSE
  // stream) is torn down here, including on assertion failure, or the
  // suite hangs on a live child process / open socket.
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(logDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function openFreshPresentation(): Promise<string> {
  const slidraPath = path.join(slidraDir, "deck.slidra");
  const created = await runCli(["new", slidraPath, "--name", "測試簡報"]);
  expect(created.ok).toBe(true);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
  // `new` creates no slides (ADR-0018): the tests below read and edit
  // slides/001.svg, so mint one page with one title text box.
  const id = opened.data!.id;
  expect((await runCli(["slide", "add", id])).ok).toBe(true);
  const added = await runCli([
    "textbox", "add", id, "slides/001.svg", "--x", "80", "--y", "80", "--width", "600", "--text", "測試簡報",
  ]);
  expect(added.ok).toBe(true);
  return id;
}

/** Same as `openFreshPresentation`, but also returns the title element's id, read via `cat` (Seam A) — never guessed. */
async function openFreshPresentationWithElement(): Promise<{ id: string; elementId: string }> {
  const id = await openFreshPresentation();
  const svgText = await readPresentationTextViaCli(id, "slides/001.svg");
  const match = /<g id="(el-[^"]+)" data-slidra-text-width/.exec(svgText);
  if (!match) throw new Error("test fixture: title element id not found");
  return { id, elementId: match[1] };
}

/** Opens a hand-built presentation (arbitrary files, given as raw bytes) — for the fs/read_text_file error-path and line/limit tests, which need control the `new`-built minimal presentation does not give. */
async function openFixturePresentation(files: Record<string, Uint8Array | string>): Promise<string> {
  const { zipSync } = await import("fflate");
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    encoded[name] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  const zipped = zipSync(encoded);
  const slidraPath = path.join(slidraDir, `fixture-${Math.random().toString(36).slice(2)}.slidra`);
  await writeFile(slidraPath, zipped);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
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

async function serve(agent: AgentAdapterConfig, presentationId?: string): Promise<RunningServer> {
  const id = presentationId ?? (await openFreshPresentation());
  const server = await startServe({ presentationId: id, port: 0, agent });
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

describe("buildCommentContext", () => {
  it("no comments: null (so runTurn sends the author's text with no prefix at all)", () => {
    expect(buildCommentContext([])).toBeNull();
  });

  it("formats each comment as '<slidePath> <target> <commentId>：<text>', one per line, in the given order", () => {
    const result = buildCommentContext([
      { id: "c-1", slidePath: "slides/001.svg", target: "el-a", author: "author", created: "t1", text: "第一則" },
      { id: "c-2", slidePath: "slides/002.svg", target: "page", author: "author", created: "t2", text: "第二則" },
    ]);
    expect(result).toBe(
      "【作者釘選的留言】\n" +
        "以下是作者釘在這份簡報上的留言，隨這則訊息一起給你。每一行的格式是「投影片路徑 目標 留言識別碼」，冒號之後是留言原文；目標是元素識別碼，或 page（代表整頁）。\n" +
        "slides/001.svg el-a c-1：第一則\n" +
        "slides/002.svg page c-2：第二則",
    );
  });
});

describe("chat: the editorial brief and prompt shape", () => {
  it("sends the editorial brief as the very first session/prompt, as a one-text-block content array", async () => {
    const id = await openFreshPresentation();
    const server = await serve(fakeAgent({ replies: [["(ack)"], ["好的"]] }), id);
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const done = sse.readUntil((e) => e.event === "chat-done");
    const response = await postChat(server, "把標題改成 Q3 財報");
    expect(response.status).toBe(202);
    await done;
    await sse.close();

    const prompts = promptEntries(await readFakeAgentLog());
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0].prompt).toEqual([{ type: "text", text: buildEditorialBrief(id) }]);
    expect(prompts[1].prompt).toEqual([{ type: "text", text: "把標題改成 Q3 財報" }]);
  });

  it("with pinned comments, the prompt carries a fixed-format prefix naming every one, ending in the author's own text", async () => {
    const id = await openFreshPresentation();
    // The fresh presentation's default `slides/001.svg` carries a bare
    // `<text>` title — not `assertSlideCompliant` until `convert` runs
    // (unrelated pre-existing state) — so `comment add`'s own compliance
    // check needs a blank `slide add` slide instead, same posture
    // `packages/cli/test/comment.test.ts` takes.
    const added = await runCli<{ slidePath: string }>(["slide", "add", id]);
    expect(added.ok).toBe(true);
    const slidePath = added.data!.slidePath;
    const textbox = await runCli<{ elementId: string }>([
      "textbox", "add", id, slidePath, "--x", "10", "--y", "10", "--width", "100", "--text", "box",
    ]);
    expect(textbox.ok).toBe(true);
    const elementId = textbox.data!.elementId;

    const elementComment = await runCli<{ commentId: string }>([
      "comment", "add", id, slidePath, elementId, "把這個標題改短一點",
    ]);
    expect(elementComment.ok).toBe(true);
    const pageComment = await runCli<{ commentId: string }>([
      "comment", "add", id, slidePath, "page", "整頁重寫成三個要點",
    ]);
    expect(pageComment.ok).toBe(true);

    const server = await serve(fakeAgent({ replies: [["(ack)"], ["好的"]] }), id);
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "麻煩照留言處理");
    await done;
    await sse.close();

    const prompts = promptEntries(await readFakeAgentLog());
    const sentText = (prompts[1].prompt[0] as { text: string }).text;
    expect(sentText).toContain(`${slidePath} ${elementId} ${elementComment.data!.commentId}：把這個標題改短一點`);
    expect(sentText).toContain(`${slidePath} page ${pageComment.data!.commentId}：整頁重寫成三個要點`);
    expect(sentText.endsWith("【作者的訊息】\n麻煩照留言處理")).toBe(true);
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
    expect(prompts).toHaveLength(3); // editorial brief + 2 user messages
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

describe("chat: cancel", () => {
  it("POST /api/chat/cancel ends the running turn with chat-done stopReason=cancelled", async () => {
    const server = await serve(fakeAgent({ replies: [["規約"], ["想一下"]], holdPromptOnIndex: 1 }));
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    // Wait for the held turn to have produced its chunk (so it is really
    // running), then stop it and read to the end of the turn.
    const untilChunk = sse.readUntil((e) => e.event === "chat-chunk");
    await postChat(server, "做一件很久的事");
    await untilChunk;

    const untilDone = sse.readUntil((e) => e.event === "chat-done");
    const cancel = await fetch(`${server.url}/api/chat/cancel`, { method: "POST" });
    expect(cancel.status).toBe(202);
    const collected = await untilDone;
    await sse.close();

    const done = collected.find((e) => e.event === "chat-done");
    expect((done!.data as { stopReason: string }).stopReason).toBe("cancelled");
    const log = await readFile(logPath, "utf-8");
    expect(log).toContain('"cancel"');
    expect(log).toContain('"heldPromptEnded":"cancelled"');
  });

  it("late updates and permission requests after a cancelled turn are dropped and refused; the next message works normally", async () => {
    const server = await serve(
      fakeAgent({ replies: [["規約"], ["想一下"], ["第二輪"]], holdPromptOnIndex: 1, lateActivityAfterCancel: true }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const untilChunk = sse.readUntil((e) => e.event === "chat-chunk");
    await postChat(server, "做一件很久的事");
    await untilChunk;
    const untilCancelled = sse.readUntil((e) => e.event === "chat-done");
    await fetch(`${server.url}/api/chat/cancel`, { method: "POST" });
    await untilCancelled;

    // Give the fake agent's late activity time to arrive (50 ms timer),
    // then run a normal second turn and read to its end: everything on
    // the stream between the two chat-done events must belong to the
    // second turn alone.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const untilSecondDone = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "第二則");
    const secondTurn = await untilSecondDone;
    await sse.close();

    const chunkTexts = secondTurn.filter((e) => e.event === "chat-chunk").map((e) => (e.data as { text: string }).text);
    expect(chunkTexts).toEqual(["第二輪"]);
    expect(secondTurn.filter((e) => e.event === "chat-command")).toHaveLength(0);
    expect((secondTurn.at(-1)!.data as { stopReason: string }).stopReason).toBe("end_turn");
    const log = await readFile(logPath, "utf-8");
    expect(log).toContain('"latePermissionOutcome":{"outcome":"cancelled"}');
  });

  it("GET /api/agent reports turnRunning=true during a held turn and false after it ends", async () => {
    const server = await serve(fakeAgent({ replies: [["規約"], ["想一下"]], holdPromptOnIndex: 1 }));
    const idle = (await (await fetch(`${server.url}/api/agent`)).json()) as { turnRunning: boolean };
    expect(idle.turnRunning).toBe(false);

    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const untilChunk = sse.readUntil((e) => e.event === "chat-chunk");
    await postChat(server, "做一件很久的事");
    await untilChunk;
    const running = (await (await fetch(`${server.url}/api/agent`)).json()) as { turnRunning: boolean };
    expect(running.turnRunning).toBe(true);

    const untilDone = sse.readUntil((e) => e.event === "chat-done");
    await fetch(`${server.url}/api/chat/cancel`, { method: "POST" });
    await untilDone;
    await sse.close();
    const after = (await (await fetch(`${server.url}/api/agent`)).json()) as { turnRunning: boolean };
    expect(after.turnRunning).toBe(false);
  });

  it("stop also drops messages queued behind the running turn, and says how many", async () => {
    const server = await serve(fakeAgent({ replies: [["規約"], ["想一下"], ["第二輪"]], holdPromptOnIndex: 1 }));
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const untilChunk = sse.readUntil((e) => e.event === "chat-chunk");
    await postChat(server, "做一件很久的事");
    await untilChunk;
    // Queued behind the held turn: never started, so stopping must throw it away.
    await postChat(server, "排在後面的第二則");

    const untilDone = sse.readUntil((e) => e.event === "chat-done");
    expect((await fetch(`${server.url}/api/chat/cancel`, { method: "POST" })).status).toBe(202);
    const collected = await untilDone;
    await sse.close();

    const notice = collected.find((e) => e.event === "chat-notice");
    expect((notice!.data as { text: string }).text).toContain("1 則尚未開始的訊息");
    // The fake agent logs every prompt it receives; the queued one never got sent.
    const log = await readFile(logPath, "utf-8");
    expect(log).not.toContain("排在後面的第二則");
  });

  it("POST /api/chat/cancel with no turn running is a 409, not a silent no-op", async () => {
    const server = await serve(fakeAgent({}));
    const response = await fetch(`${server.url}/api/chat/cancel`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("沒有進行中的回合");
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

describe("chat: session/request_permission — presentation files must go through the CLI, everything else is allowed", () => {
  /** Runs one permission scenario and returns the outcome the fake agent logged. */
  async function permissionOutcomeFor(config: Record<string, unknown>): Promise<unknown> {
    const server = await serve(
      fakeAgent({ replies: [["(ack)"], ["好的"]], requestPermissionOnPromptIndex: 1, ...config }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "幫我執行一個工具");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    return log.find((entry) => "permissionOutcome" in entry)?.permissionOutcome;
  }

  it("allows a plain slidra command, selecting the offered allow option", async () => {
    const outcome = await permissionOutcomeFor({ permissionCommand: "slidra text set abc slides/001.svg el-1 新標題" });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("allows Codex's shell argv after validating the entire script", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: ["/bin/zsh", "-lc", "slidra text set abc slides/001.svg el-1 '新標題'"],
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  // codex-acp sends the shell-*quoted* form of the command, not the script
  // itself (see `unquoteShellWord`): a command carrying quotes of its own
  // arrives wrapped in quotes it never had. Without unquoting, every
  // writing command is refused on its leading `"`.
  it("allows a slidra command codex-acp sent in its shell-quoted form", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: `"slidra text set abc slides/001.svg el-1 '新標題'"`,
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  // Verbatim from codex-acp's own shlexQuote: adjacent double- and
  // single-quoted chunks for one `plan set` whose argument spans lines.
  it("allows a shell-quoted command built from several adjacent quoted chunks", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: `"slidra plan set abc outline '"'\`\`\`json\n{ "n": 1 }\n\`\`\`'"'"`,
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  // codex-acp offers two different reject_once options: `decline` skips
  // the command and lets the turn continue, `cancel` is Codex's abort.
  it("refuses with decline, not the abort, when the adapter offers both", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: `rm -rf ${slidraHome}/work/abc`,
      permissionOptions: [
        { kind: "allow_once", name: "允許", optionId: "allow_once" },
        { kind: "reject_once", name: "中止整個回合", optionId: "cancel" },
        { kind: "reject_once", name: "不跑這條，繼續", optionId: "decline" },
      ],
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "decline" });
  });

  // Once a direct read of a presentation file is refused, the whole turn used to
  // die on the adapter's `interrupt: true`, with the agent only ever hearing
  // "user rejected". Now Slidra picks the turn back up and tells it what to use instead.
  it("turns a refused command into a suggestion sent back to the agent, and the turn continues", async () => {
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"], ["知道了，改用讀檔工具"]],
        requestPermissionOnPromptIndex: 1,
        permissionCommand: `cat ${slidraHome}/work/abc/slides/001.svg`,
        permissionOptions: [
          { kind: "allow_once", name: "允許", optionId: "allow_once" },
          { kind: "reject_once", name: "中止整個回合", optionId: "cancel" },
        ],
        abortTurnAfterPermission: true,
      }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const untilDone = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下規範");
    const collected = await untilDone;
    await sse.close();

    // The turn does not die on cancelled.
    expect((collected.at(-1)!.data as { stopReason: string }).stopReason).toBe("end_turn");
    // The second prompt the agent receives is exactly that suggestion.
    const prompts = (await readFakeAgentLog()).filter((entry) => entry.prompt !== undefined);
    expect(JSON.stringify(prompts.at(-1)!.prompt)).toContain("slidra cat");
    // The author can see that this happened.
    expect(collected.some((e) => e.event === "chat-notice")).toBe(true);
  });

  // This path is only hit when the command string can't be recovered at all
  // (only a protected path sits in rawInput), so there's no suggestion to give:
  // the turn genuinely ends, but at least it's made clear the author didn't stop it.
  it("says so when a refused command took the whole turn down with it", async () => {
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        requestPermissionOnPromptIndex: 1,
        permissionRawInput: { script: `${slidraHome}/work/abc/slides/001.svg` },
        // Only the abort on offer, and the adapter aborts the turn on it.
        permissionOptions: [
          { kind: "allow_once", name: "允許", optionId: "allow_once" },
          { kind: "reject_once", name: "中止整個回合", optionId: "cancel" },
        ],
        abortTurnAfterPermission: true,
      }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const untilDone = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "幫我執行一個工具");
    const collected = await untilDone;
    await sse.close();

    const texts = collected.filter((e) => e.event === "chat-notice").map((e) => (e.data as { text: string }).text);
    expect(texts.some((text) => text.includes("不是作者按了停止"))).toBe(true);
  });

  it("forwards the adapter's own stderr to serve's log, tagged with its name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const server = await serve(fakeAgent({ replies: [["(ack)"], ["好的"]], stderrLine: "adapter said something" }));
      const stream = await fetch(`${server.url}/api/chat/stream`);
      const sse = new SseReader(stream);
      const done = sse.readUntil((e) => e.event === "chat-done");
      await postChat(server, "隨便一句");
      await done;
      await sse.close();
      expect(warn.mock.calls.map(String)).toContain("[Claude Code] adapter said something");
    } finally {
      warn.mockRestore();
    }
  });

  // Policy update: Slidra now only protects the presentation's own files;
  // every other shell command is allowed. The group below guards the new
  // line — `<SLIDRA_HOME>` (aside from the agent's own work directory)
  // and any `.slidra` container may only be touched through the CLI.

  it("refuses a command that writes straight into the presentation's work directory", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: `sed -i s/a/b/ ${slidraHome}/work/abc/slides/001.svg`,
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("refuses a command that reads Slidra's own bookkeeping", async () => {
    const outcome = await permissionOutcomeFor({ permissionCommand: `cat ${slidraHome}/projects.json` });
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("refuses a command that opens a .slidra container directly, wherever it lives", async () => {
    const outcome = await permissionOutcomeFor({ permissionCommand: "unzip /tmp/somebody-elses.slidra -d /tmp/out" });
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("refuses a protected path buried inside another program's script argument", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: `sh -c 'rm -rf ${slidraHome}/history/abc'`,
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("refuses a protected path in a raw input shape whose command cannot be read at all", async () => {
    const outcome = await permissionOutcomeFor({
      permissionRawInput: { script: `${slidraHome}/work/abc/slides/001.svg` },
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "reject" });
  });

  // The other half: commands that don't touch presentation files are no longer
  // blocked — that's the actual point of this policy update.

  it("allows an ordinary shell command that has nothing to do with the presentation", async () => {
    const outcome = await permissionOutcomeFor({ permissionCommand: "grep -rn pyramid reference/" });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("allows a pipeline, a redirect and a chained command outside the presentation", async () => {
    const outcome = await permissionOutcomeFor({ permissionCommand: "ls /tmp | head -3 > /tmp/listing && echo done" });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("allows a slidra command with a pipe — the CLI is the CLI however it is spelled", async () => {
    const outcome = await permissionOutcomeFor({ permissionCommand: "slidra ls abc | head -3" });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("allows a tool call that names no path at all", async () => {
    const outcome = await permissionOutcomeFor({ permissionOmitCommand: true });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("allows a double-quoted argument, which the old character grammar refused outright", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: 'slidra text set abc slides/001.svg el-1 "第三季 財報"',
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("allows a single-quoted Chinese argument containing spaces", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: "slidra text set abc slides/001.svg el-1 '第三季 財報 標題'",
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("allows a slidra command with a trailing 2>&1", async () => {
    const outcome = await permissionOutcomeFor({ permissionCommand: "slidra cat abc project.json 2>&1" });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });
});

describe("chat: session/request_permission never accepts a persistent grant", () => {
  /** Runs one permission scenario and returns the outcome the fake agent logged. */
  async function permissionOutcomeFor(config: Record<string, unknown>): Promise<unknown> {
    const server = await serve(
      fakeAgent({ replies: [["(ack)"], ["好的"]], requestPermissionOnPromptIndex: 1, ...config }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "幫我執行一個工具");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    return log.find((entry) => "permissionOutcome" in entry)?.permissionOutcome;
  }

  // Some adapters stop calling session/request_permission
  // for a tool once a persistent grant (allow_always) has been given —
  // accepting it once would silently disable this gate for every later
  // command in the session, including non-slidra ones. Only allow_once
  // may ever be selected for an allow decision.

  it("allows a valid slidra command when allow_once is offered", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: "slidra ls abc",
      permissionOptions: [
        { kind: "allow_once", name: "允許一次", optionId: "allow-once" },
        { kind: "allow_always", name: "永遠允許", optionId: "allow-always" },
        { kind: "reject_once", name: "拒絕", optionId: "reject" },
      ],
    });
    expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("refuses a valid slidra command when only allow_always is offered, rather than accepting a persistent grant", async () => {
    const outcome = await permissionOutcomeFor({
      permissionCommand: "slidra ls abc",
      permissionOptions: [
        { kind: "allow_always", name: "永遠允許", optionId: "allow-always" },
        { kind: "reject_once", name: "拒絕", optionId: "reject" },
      ],
    });
    expect(outcome).toEqual({ outcome: "cancelled" });
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
  it("hands the agent the deployed product work directory as its cwd, never the real process cwd", async () => {
    const id = await openFreshPresentation();
    const server = await serve(fakeAgent({ replies: [["(ack)"]] }), id);
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
    // Exactly `<SLIDRA_HOME>/agent/<presentationId>`, resolved — the
    // product work directory `deployAgentWorkdir()` deploys before
    // `startServe` ever
    // constructs the session. The escape-hatch this test used to
    // assert ("never under SLIDRA_HOME") is inverted by design: `../work/<id>`
    // is no longer reachable from here, because `fs/read_text_file`'s
    // containment is the deployed directory's own real tree
    // (`classifyAgentReadPath`/`readAgentWorkdirFile`), not a string prefix
    // check an agent could try to walk out of.
    const expectedWorkdir = await realpath(path.join(slidraHome, "agent", id));
    expect(sentCwd).toBe(expectedWorkdir);
  });

  it("lets the agent read the deployed CLAUDE.md via a relative path", async () => {
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "CLAUDE.md",
      }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下你的工作手冊入口");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const result = log.find((entry) => "readTextFileResult" in entry) as { readTextFileResult?: string } | undefined;
    const sourceClaudeMd = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../agent-workdir/CLAUDE.md",
    );
    expect(result?.readTextFileResult).toBe(await readFile(sourceClaudeMd, "utf8"));
  });

  it("lets the agent read a file under the deployed .claude/skills tree via a relative path", async () => {
    const id = await openFreshPresentation();
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: ".claude/skills/probe/SKILL.md",
      }),
      id,
    );
    // Written directly into the *deployed* target after `serve()` has
    // already run `deployAgentWorkdir()` once — not into the repo's
    // `agent-workdir/` source, which this test must never touch, and which
    // a second deploy would overwrite anyway. This only proves the read
    // wiring reaches the real, already-deployed `.claude/skills` tree; skill
    // *content* is out of scope here.
    const skillDir = path.join(slidraHome, "agent", id, ".claude", "skills", "probe");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "測試用 skill 內容");

    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下這個 skill");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const result = log.find((entry) => "readTextFileResult" in entry) as { readTextFileResult?: string } | undefined;
    expect(result?.readTextFileResult).toBe("測試用 skill 內容");
  });
});

describe("chat: serve close does not delete the deployed work directory", () => {
  it("leaves the work directory's AGENTS.md readable and unchanged after close()", async () => {
    const id = await openFreshPresentation();
    const server = await serve(fakeAgent({ replies: [["(ack)"]] }), id);
    // This test owns close()/assert itself — see the shutdown-hang test
    // above for why afterEach must not also try to close it.
    servers = servers.filter((running) => running !== server);
    await server.close();

    const sourceAgentsMd = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../agent-workdir/AGENTS.md"),
      "utf8",
    );
    const deployedAgentsMd = await readFile(path.join(slidraHome, "agent", id, "AGENTS.md"), "utf8");
    expect(deployedAgentsMd).toBe(sourceAgentsMd);
  });
});

describe("chat: a failed start must not leak its subprocess", () => {
  it("tears down the failed attempt's child so a retry leaves exactly one live child process", async () => {
    const markerDir = await mkdtemp(path.join(tmpdir(), "slidra-chat-marker-"));
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
      await rm(markerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("chat: an exited adapter must not deadlock the chat forever", () => {
  it(
    "errors out the pending turn instead of hanging, and a later message starts a fresh, working session",
    async () => {
      const markerDir = await mkdtemp(path.join(tmpdir(), "slidra-chat-exit-marker-"));
      const markerPath = path.join(markerDir, "exited-once");
      try {
        // exitDuringPromptIndex: 1 is the author's first message (index 0 is
        // the editorial brief) — the fake agent exits instead of replying, exactly
        // once (exitOnceMarkerPath), simulating the adapter dying mid-turn.
        const server = await serve(
          fakeAgent({
            replies: [["(ack)"], ["好的"]],
            exitDuringPromptIndex: 1,
            exitOnceMarkerPath: markerPath,
          }),
        );
        const stream = await fetch(`${server.url}/api/chat/stream`);
        const sse = new SseReader(stream);

        // First message: the child dies mid-turn. Before the fix, the SDK
        // never settles the pending `session/prompt` call on EOF, so this
        // would hang forever instead of ever reaching chat-error.
        const wedgedTurnError = sse.readUntil((e) => e.event === "chat-error");
        const raced = Promise.race([
          wedgedTurnError.then(() => "errored" as const),
          new Promise((resolve) => setTimeout(() => resolve("timed-out" as const), 5000)),
        ]);
        await postChat(server, "第一則訊息，agent 會在這裡掛掉");
        expect(await raced).toBe("errored");
        const collected = await wedgedTurnError;
        const errorEvent = collected.find((e) => e.event === "chat-error");
        expect(errorEvent).toBeDefined();
        const message = (errorEvent!.data as { message: string }).message;
        expect(message).toContain("Claude Code");
        expect(message).toMatch(/重新發送訊息/);

        // Second message: a fresh subprocess spawn (the marker means it
        // will not exit again this time) must start a genuinely working
        // session, not reuse the dead one.
        const secondDone = sse.readUntil((e) => e.event === "chat-done");
        await postChat(server, "第二則訊息，這次應該要正常運作");
        await secondDone;
        await sse.close();

        const pids = (await readFakeAgentLog())
          .filter((entry) => entry.pid !== undefined)
          .map((entry) => entry.pid!);
        expect(pids).toHaveLength(2);
        await waitFor(() => !isAlive(pids[0]));
        expect(isAlive(pids[0])).toBe(false);
      } finally {
        await rm(markerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    15000,
  );
});

/** Minimal, valid project.json bytes for `openFixturePresentation` fixtures below. */
function fixtureProjectJson(slides: string[]): string {
  return JSON.stringify({ formatVersion: 1, name: "fixture", canvas: { width: 1280, height: 720 }, slides });
}

describe("chat: fs/read_text_file serves virtual paths, never real ones", () => {
  it("returns a slide's full content, byte-for-byte as cat returns it", async () => {
    const id = await openFreshPresentation();
    const expected = await readPresentationTextViaCli(id, "slides/001.svg");

    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "slides/001.svg",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下投影片");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const result = log.find((entry) => "readTextFileResult" in entry) as { readTextFileResult?: string } | undefined;
    expect(result?.readTextFileResult).toBe(expected);
  });

  it("fails with an explicit ACP error carrying the existing wording, and no real path, for a path that does not resolve", async () => {
    const id = await openFreshPresentation();
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "does/not/exist.svg",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下不存在的檔案");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const errorEntry = log.find((entry) => "readTextFileError" in entry) as
      | { readTextFileError?: { code: number; message: string } }
      | undefined;
    expect(errorEntry?.readTextFileError?.message).toBe("找不到檔案：does/not/exist.svg");
    expect(errorEntry?.readTextFileError?.message).not.toContain(slidraHome);
  });

  it("fails explicitly for a directory — not an empty string, not a listing", async () => {
    const id = await openFreshPresentation();
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "slides",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下 slides 目錄");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const errorEntry = log.find((entry) => "readTextFileError" in entry) as
      | { readTextFileError?: { code: number; message: string } }
      | undefined;
    expect(errorEntry?.readTextFileError?.message).toBe("不是檔案：slides");
  });

  it("keeps the existing text-read refusal for a binary asset — this method does not widen what cat allows", async () => {
    const id = await openFixturePresentation({
      "project.json": fixtureProjectJson(["slides/001.svg"]),
      "slides/001.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "assets/pic.bin": new Uint8Array([0xff, 0x00, 0x01]), // never valid as a UTF-8 lead byte
    });
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "assets/pic.bin",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下這張圖");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const errorEntry = log.find((entry) => "readTextFileError" in entry) as
      | { readTextFileError?: { code: number; message: string } }
      | undefined;
    expect(errorEntry?.readTextFileError?.message).toBe("assets/pic.bin 是二進位資產，無法以文字讀取");
  });

  it("honours line (1-based) and limit (max line count) per ACP semantics", async () => {
    const id = await openFixturePresentation({
      "project.json": fixtureProjectJson(["slides/001.svg"]),
      // Every chat turn now reads this file's comments (`<svg>`-rooted,
      // per `readSlideComments`) before relaying the prompt, so "line1" is
      // wrapped in a self-contained `<svg>` root to stay parseable — line 2/3/4
      // are untouched plain text, preserving the exact line/limit semantics
      // this test is actually about.
      "slides/001.svg": '<svg xmlns="http://www.w3.org/2000/svg">line1</svg>\nline2\nline3\nline4\n',
    });
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "slides/001.svg",
        readTextFileLine: 2,
        readTextFileLimit: 2,
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "只讀第 2、3 行");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const result = log.find((entry) => "readTextFileResult" in entry) as { readTextFileResult?: string } | undefined;
    // line 2 is 1-based ("line2"); limit 2 caps it at two lines.
    expect(result?.readTextFileResult).toBe("line2\nline3");
  });

  // A real, conforming ACP agent sends `path` as an
  // *absolute* path rooted at the session cwd it was handed — never the
  // bare relative virtual path the brief names (confirmed against a real
  // `claude-code-acp` 0.12.6 probe). The test below drives the fake agent
  // through `readTextFileAbsoluteUnderCwd`, which reproduces exactly that
  // shape: it resolves the cwd it received via `session/new` and joins the
  // relative path onto the resolved form, the same thing the real adapter
  // was observed doing.

  it("translates an absolute path under the session cwd back into the virtual path and reads it", async () => {
    const id = await openFreshPresentation();
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        // The fixture builds this path by calling fs.realpathSync on the
        // cwd it received — the same resolution step a real adapter
        // performs, confirmed against a real `claude-code-acp` 0.12.6: the
        // cwd sent to `session/new` was `/var/folders/...`, but the `path`
        // a subsequent `fs/read_text_file` sent back was
        // `/private/var/folders/...` (macOS resolves that `/var` symlink).
        // A prefix comparison against an unresolved cwd string would fail
        // here on every macOS run; comparing against the resolved form is
        // what this test exists to catch, and what actually matches.
        readTextFileAbsoluteUnderCwd: "slides/001.svg",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下投影片");
    await done;
    await sse.close();

    const expected = await readPresentationTextViaCli(id, "slides/001.svg");
    const log = await readFakeAgentLog();
    const result = log.find((entry) => "readTextFileResult" in entry) as { readTextFileResult?: string } | undefined;
    // Before the fix this could not resolve at all — the whole absolute
    // string was handed to `readPresentationFile` verbatim.
    expect(result?.readTextFileResult).toBe(expected);
  });

  it("honours line and limit when the whole slide is read this way (the ordinary case, not an edge case)", async () => {
    const id = await openFreshPresentation();
    const expected = await readPresentationTextViaCli(id, "slides/001.svg");
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFileAbsoluteUnderCwd: "slides/001.svg",
        // The exact values a real claude-code-acp 0.12.6 was probed
        // sending on an ordinary whole-file read: line 1, limit 2000 — not
        // null/omitted, as the earlier relative-path test already covers.
        readTextFileLine: 1,
        readTextFileLimit: 2000,
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下投影片");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const result = log.find((entry) => "readTextFileResult" in entry) as { readTextFileResult?: string } | undefined;
    expect(result?.readTextFileResult).toBe(expected);
  });

  it("refuses an absolute path outside the session cwd, explicitly, without ever touching the real filesystem or leaking a real path", async () => {
    const id = await openFreshPresentation();
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "/etc/passwd",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下這個路徑");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const errorEntry = log.find((entry) => "readTextFileError" in entry) as
      | { readTextFileError?: { code: number; message: string } }
      | undefined;
    // Explicit refusal — never resolved against the real filesystem — and
    // the message names no real path at all, not even the one the agent
    // itself sent.
    expect(errorEntry?.readTextFileError?.message).toBe("找不到檔案：路徑不在這個工作階段的範圍內");
    expect(errorEntry?.readTextFileError?.message).not.toContain("/etc/passwd");
  });

  it("still resolves a relative path through the virtual tree exactly as before this fix", async () => {
    const id = await openFreshPresentation();
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        readTextFileOnPromptIndex: 1,
        readTextFilePath: "slides/001.svg",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "讀一下投影片");
    await done;
    await sse.close();

    const expected = await readPresentationTextViaCli(id, "slides/001.svg");
    const log = await readFakeAgentLog();
    const result = log.find((entry) => "readTextFileResult" in entry) as { readTextFileResult?: string } | undefined;
    expect(result?.readTextFileResult).toBe(expected);
  });
});

describe("chat: fs/write_text_file always refuses, and the refusal names the command to use instead", () => {
  it("refuses, naming slidra text set, and writes nothing", async () => {
    const id = await openFreshPresentation();
    const before = await readPresentationTextViaCli(id, "slides/001.svg");

    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的"]],
        writeTextFileOnPromptIndex: 1,
        writeTextFilePath: "slides/001.svg",
        writeTextFileContent: "<svg>hacked</svg>",
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "直接改一下檔案");
    await done;
    await sse.close();

    const log = await readFakeAgentLog();
    const errorEntry = log.find((entry) => "writeTextFileError" in entry) as
      | { writeTextFileError?: { code: number; message: string } }
      | undefined;
    expect(errorEntry?.writeTextFileError?.message).toContain("slidra text set");
    expect(log.some((entry) => "writeTextFileResult" in entry)).toBe(false);

    const after = await readPresentationTextViaCli(id, "slides/001.svg");
    expect(after).toBe(before);
  });
});

describe("chat: the whole loop — read via the file method, request permission, allowed, change visible through a read", () => {
  it("lets the agent read the slide, get permission for slidra text set, and see the edit afterwards only through another read", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();

    // The id used to build the permission command below
    // must be one a real agent could actually have read out of the editorial brief
    // itself — never the test's own `id` variable spliced in directly, which
    // would prove nothing about whether the brief actually hands the agent
    // a usable id. Parsing it out of the exact text `buildEditorialBrief`
    // produces — the same text `session.ts` sends as the very first
    // prompt — is what makes "the agent could have constructed this
    // command from the brief alone" true instead of merely assumed.
    const briefIdMatch = /識別碼是：(\S+)/.exec(buildEditorialBrief(id));
    if (!briefIdMatch) throw new Error("test fixture: 編輯規約 does not name a presentation id");
    const idFromBrief = briefIdMatch[1];
    expect(idFromBrief).toBe(id); // sanity: the brief really does name this presentation

    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["好的，我先讀一下"], ["改好了"]],
        readTextFileEveryPromptFrom: 1,
        readTextFilePath: "slides/001.svg",
        requestPermissionOnPromptIndex: 1,
        // Single-quoted, per the editorial brief's quoting rule:
        // double quotes are refused outright by the new allowlist grammar,
        // so a real agent following the brief would quote this way.
        permissionCommand: `slidra text set ${idFromBrief} slides/001.svg ${elementId} 'Q3 財報'`,
      }),
      id,
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    // Turn 1: the agent reads the slide (through the file method — the only
    // content it has ever seen) and is granted permission to run the
    // text-set command it read enough to construct.
    const firstDone = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "把標題改成 Q3 財報");
    await firstDone;

    const logAfterFirst = await readFakeAgentLog();
    const readResult = logAfterFirst.find((entry) => "readTextFileResult" in entry) as
      | { readTextFileResult?: string }
      | undefined;
    expect(readResult?.readTextFileResult).toContain("測試簡報"); // the original title, read before editing
    const permissionEntry = logAfterFirst.find((entry) => "permissionOutcome" in entry);
    expect(permissionEntry?.permissionOutcome).toEqual({ outcome: "selected", optionId: "allow" });

    // The permission grant only authorizes the command — actually running
    // it is the agent's own business (ADR-0006), which this fake agent does
    // not simulate a real shell for. Applying it here, through the exact
    // `slidra` binary the agent's permission command names, is what the
    // agent's own Bash tool would have done once permission came back
    // "allow".
    const mutation = await runCli(["text", "set", id, "slides/001.svg", elementId, "Q3 財報"]);
    expect(mutation.ok).toBe(true);

    // Turn 2: the change is confirmed only by reading again through the ACP
    // file method — never by inspecting the work directory's real path.
    const secondDone = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "確認一下改好了嗎");
    await secondDone;
    await sse.close();

    const fullLog = await readFakeAgentLog();
    const readResults = fullLog.filter((entry) => "readTextFileResult" in entry) as Array<{ readTextFileResult?: string }>;
    expect(readResults).toHaveLength(2);
    expect(readResults[1].readTextFileResult).toContain("Q3 財報");
    expect(readResults[1].readTextFileResult).not.toContain("測試簡報");
  });
});

describe("chat: the author can see the command run", () => {
  /** Runs one scripted command life cycle and returns every SSE event seen up to chat-done. */
  async function commandEventsFor(
    scenario: Record<string, unknown>,
  ): Promise<Array<{ event: string; data: unknown }>> {
    const server = await serve(
      fakeAgent({
        replies: [["(ack)"], ["現在來修改文字："]],
        toolCallOnPromptIndex: 1,
        ...scenario,
      }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const events = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "把標題改成新標題");
    const collected = await events;
    await sse.close();
    return collected;
  }

  it("relays the command and its successful ending, with the command text verbatim from rawInput.command", async () => {
    const events = await commandEventsFor({ toolCallCommand: "slidra ls p1" });

    const started = events.find((e) => e.event === "chat-command");
    expect(started?.data).toEqual({
      toolCallId: "fake-command-call",
      cli: true,
      command: "slidra ls p1",
      status: "pending",
    });

    const updates = events.filter((e) => e.event === "chat-command-update").map((e) => e.data);
    expect(updates).toEqual([
      { toolCallId: "fake-command-call", status: "in_progress" },
      { toolCallId: "fake-command-call", status: "completed" },
    ]);
  });

  it("relays a failed command together with its output, so the author never has to open a terminal", async () => {
    const events = await commandEventsFor({
      toolCallCommand: "slidra text set p1 slides/001.svg el-1 '新標題'",
      toolCallOutcome: "failed",
      toolCallOutput: "zsh: command not found: slidra\nexit code 127",
    });

    const failure = events
      .filter((e) => e.event === "chat-command-update")
      .map((e) => e.data as { status: string })
      .find((data) => data.status === "failed");
    expect(failure).toEqual({
      toolCallId: "fake-command-call",
      status: "failed",
      output: "zsh: command not found: slidra\nexit code 127",
    });
  });

  it("shows a refused non-CLI command untagged, and tells the author in one line", async () => {
    // The command still shows up on the timeline (the author can see what
    // happened on the machine), but with no status tag — it isn't a CLI
    // operation. Being refused is communicated by a single notice instead.
    const events = await commandEventsFor({
      toolCallCommand: `sed -i s/a/b/ ${slidraHome}/work/p1/slides/001.svg`,
      permissionForToolCall: true,
      toolCallOutcome: "failed",
      toolCallOutput: "The user doesn't want to proceed with this tool use.",
    });

    const started = events.find((event) => event.event === "chat-command");
    expect((started!.data as { cli: boolean }).cli).toBe(false);
    // With no tag, there's no follow-up status update.
    expect(events.filter((event) => event.event === "chat-command-update")).toEqual([]);
    const notice = events.find((event) => event.event === "chat-notice");
    expect((notice!.data as { text: string }).text).toContain("擋下了 agent 直接動簡報檔案");
  });

  it("leaves a command's own failure alone — only a refused one gets Slidra's wording", async () => {
    const events = await commandEventsFor({
      toolCallCommand: "slidra ls p1",
      permissionForToolCall: true,
      toolCallOutcome: "failed",
      toolCallOutput: "exit code 1",
    });

    const failure = events
      .filter((event) => event.event === "chat-command-update")
      .map((event) => event.data as { status: string; output?: string; blocked?: true })
      .find((data) => data.status === "failed");
    expect(failure).toEqual({ toolCallId: "fake-command-call", status: "failed", output: "exit code 1" });
  });

  it.each([
    { toolCallRawOutput: "command output" },
    { toolCallRawOutput: [{ type: "text", text: "command output" }] },
  ])(
    "accepts adapter tool updates with non-object rawOutput %j",
    async ({ toolCallRawOutput }) => {
      const events = await commandEventsFor({ toolCallRawOutput });
      expect(events.filter((event) => event.event === "chat-command-update").map((event) => event.data))
        .toContainEqual({ toolCallId: "fake-command-call", status: "completed" });
    },
  );

  it("never relays a tool call that is not a shell command", async () => {
    const events = await commandEventsFor({ toolCallOmitCommand: true });

    expect(events.filter((e) => e.event.startsWith("chat-command"))).toEqual([]);
  });

  it("never relays commands from the editorial brief turn", async () => {
    const server = await serve(
      fakeAgent({ replies: [["(ack)"], ["好的"]], toolCallOnPromptIndex: 0, toolCallCommand: "slidra ls p1" }),
    );
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);

    const events = sse.readUntil((e) => e.event === "chat-done");
    await postChat(server, "你好");
    const collected = await events;
    await sse.close();

    expect(collected.filter((e) => e.event.startsWith("chat-command"))).toEqual([]);
  });
});
