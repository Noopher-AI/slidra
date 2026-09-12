import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServe } from "../../src/serve.js";
import type { RunningServer } from "../../src/serve.js";
import type { AgentAdapterConfig } from "../../src/agent/session.js";
import {
  collectSlashCommands,
  mergeSlashCommands,
  parseSkillFrontmatter,
  readSkillCommands,
  type SlashCommand,
} from "../../src/agent/commands.js";

// [E3.T3] #232/#236 — the `/` list's architecture decision is "three
// standing sources, unioned" (agent report ∪ bundled skills ∪ user
// skills), not a fallback. Pure-function tests below cover the frontmatter
// parser, the directory scan, and the merge/priority rules directly; the
// Seam B tests at the bottom drive a real server over HTTP with a scripted
// fake ACP agent, the same posture chat.test.ts uses.

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-acp-agent.mjs");
const slidraBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../target/release/slidra");
const execFileAsync = promisify(execFile);

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

describe("parseSkillFrontmatter", () => {
  it("reads name and description from frontmatter", () => {
    const text = "---\nname: outline\ndescription: 從大綱建立投影片\n---\n\n# Outline\n";
    expect(parseSkillFrontmatter(text, "outline-dir")).toEqual({ name: "outline", description: "從大綱建立投影片" });
  });

  it("no frontmatter at all: name falls back to the directory name, description is empty", () => {
    expect(parseSkillFrontmatter("# Just a heading\n", "my-skill")).toEqual({ name: "my-skill", description: "" });
  });

  it("frontmatter present but missing name: falls back to the directory name; missing description: empty string", () => {
    const text = "---\ndescription: 只有描述\n---\n";
    expect(parseSkillFrontmatter(text, "no-name-dir")).toEqual({ name: "no-name-dir", description: "只有描述" });
  });
});

async function mkSkill(dir: string, name: string, frontmatter: string | undefined): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  if (frontmatter !== undefined) {
    await writeFile(path.join(skillDir, "SKILL.md"), frontmatter, "utf8");
  }
}

describe("readSkillCommands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "slidra-skills-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("scans every immediate subdirectory with a SKILL.md, tagging each with the given source", async () => {
    await mkSkill(dir, "outline", "---\nname: outline\ndescription: 從大綱建立投影片\n---\n");
    await mkSkill(dir, "review", "---\nname: review\ndescription: 檢查投影片\n---\n");

    const commands = await readSkillCommands(dir, "bundled");
    expect(commands).toEqual(
      expect.arrayContaining([
        { name: "outline", description: "從大綱建立投影片", source: "bundled" },
        { name: "review", description: "檢查投影片", source: "bundled" },
      ]),
    );
    expect(commands).toHaveLength(2);
  });

  it("a subdirectory with no SKILL.md contributes nothing", async () => {
    await mkSkill(dir, "outline", "---\nname: outline\ndescription: x\n---\n");
    await mkSkill(dir, "empty-dir", undefined);

    const commands = await readSkillCommands(dir, "user");
    expect(commands).toEqual([{ name: "outline", description: "x", source: "user" }]);
  });

  it("a skill installed as a symlink to a directory elsewhere is picked up (how skillshare installs them)", async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), "slidra-skill-src-"));
    await mkSkill(elsewhere, "linked", "---\nname: linked\ndescription: 透過 symlink 安裝\n---\n");
    await symlink(path.join(elsewhere, "linked"), path.join(dir, "linked"));

    const commands = await readSkillCommands(dir, "user");
    expect(commands).toEqual([{ name: "linked", description: "透過 symlink 安裝", source: "user" }]);
    await rm(elsewhere, { recursive: true, force: true });
  });

  it("a plain file sitting in the skill directory (.DS_Store) contributes nothing", async () => {
    await writeFile(path.join(dir, ".DS_Store"), "junk");

    const commands = await readSkillCommands(dir, "user");
    expect(commands).toEqual([]);
  });

  it("a non-existent directory returns an empty list, not an error", async () => {
    const commands = await readSkillCommands(path.join(dir, "does-not-exist"), "bundled");
    expect(commands).toEqual([]);
  });
});

describe("mergeSlashCommands", () => {
  it("unions groups, keeping the first occurrence of a name (agent > bundled > user priority is the caller's group order)", () => {
    const agent: SlashCommand[] = [{ name: "outline", description: "agent 版描述", source: "agent" }];
    const bundled: SlashCommand[] = [
      { name: "outline", description: "bundled 版描述", source: "bundled" },
      { name: "review", description: "bundled review", source: "bundled" },
    ];
    const user: SlashCommand[] = [{ name: "review", description: "user review", source: "user" }];

    const merged = mergeSlashCommands([agent, bundled, user]);
    expect(merged).toEqual([
      { name: "outline", description: "agent 版描述", source: "agent" },
      { name: "review", description: "bundled review", source: "bundled" },
    ]);
  });

  it("sorts by name with plain < (not locale-dependent)", () => {
    const merged = mergeSlashCommands([
      [
        { name: "zebra", description: "", source: "bundled" },
        { name: "apple", description: "", source: "bundled" },
        { name: "mango", description: "", source: "bundled" },
      ],
    ]);
    expect(merged.map((c) => c.name)).toEqual(["apple", "mango", "zebra"]);
  });
});

describe("collectSlashCommands", () => {
  let bundledDir: string;
  let userDir: string;

  beforeEach(async () => {
    bundledDir = await mkdtemp(path.join(tmpdir(), "slidra-bundled-"));
    userDir = await mkdtemp(path.join(tmpdir(), "slidra-user-"));
  });

  afterEach(async () => {
    await rm(bundledDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  });

  it("strips one leading '/' off an agent-reported name", async () => {
    const commands = await collectSlashCommands([{ name: "/outline", description: "x" }], {
      bundled: bundledDir,
      user: userDir,
    });
    expect(commands).toEqual([{ name: "outline", description: "x", source: "agent" }]);
  });

  it("drops a reported command whose name normalizes to empty, without failing the rest", async () => {
    const commands = await collectSlashCommands(
      [
        { name: "/", description: "只有斜線本身" },
        { name: "outline", description: "x" },
      ],
      { bundled: bundledDir, user: userDir },
    );
    expect(commands).toEqual([{ name: "outline", description: "x", source: "agent" }]);
  });

  it("no agent report and both directories empty: []", async () => {
    const commands = await collectSlashCommands([], { bundled: bundledDir, user: userDir });
    expect(commands).toEqual([]);
  });
});

/** Same posture as chat.test.ts's own SseReader: accumulate to the blank line, parse event/data pairs. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  async readUntil(predicate: (event: { event: string; data: unknown }) => boolean): Promise<{ event: string; data: unknown }> {
    while (true) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("stream ended before predicate matched");
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
          if (predicate(parsed)) return parsed;
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

describe("Seam B: GET /api/agent/commands and the agent-commands SSE event", () => {
  let slidraHome: string;
  let slidraDir: string;
  let bundledDir: string;
  let userDir: string;
  let servers: RunningServer[];

  beforeEach(async () => {
    slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-cmd-home-"));
    slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-cmd-files-"));
    bundledDir = await mkdtemp(path.join(tmpdir(), "slidra-cmd-bundled-"));
    userDir = await mkdtemp(path.join(tmpdir(), "slidra-cmd-user-"));
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
    await rm(bundledDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function fakeAgent(scenario: Record<string, unknown>): AgentAdapterConfig {
    return { kind: "claude", label: "Claude Code", command: process.execPath, args: [fixturePath], env: { FAKE_AGENT_CONFIG: JSON.stringify(scenario) } };
  }

  async function serve(agent: AgentAdapterConfig): Promise<RunningServer> {
    const deckPath = path.join(slidraDir, "deck.slidra");
    const created = await runCli(["new", deckPath, "--name", "測試簡報"]);
    expect(created.ok).toBe(true);
    const opened = await runCli<{ id: string }>(["open", deckPath]);
    expect(opened.ok).toBe(true);
    const server = await startServe({
      presentationId: opened.data!.id,
      port: 0,
      agent,
      skillDirs: { bundled: bundledDir, user: userDir },
    });
    servers.push(server);
    return server;
  }

  it("AC1: an agent reporting commands that simulate two layers (a shipped-style and a user-style skill) all appear, with correct descriptions, via GET", async () => {
    const server = await serve(
      fakeAgent({
        availableCommands: [
          { name: "outline", description: "從大綱建立投影片" },
          { name: "review", description: "檢查投影片內容" },
        ],
        replies: [["(ack)"], ["好的"]],
      }),
    );
    // The agent subprocess is spawned lazily on the first chat message
    // (session.ts's ensureSession) — before that, it has reported nothing.
    // The 編輯規約 turn (prompt index 0) is what actually triggers
    // `session/new`, so waiting for its own chat-done is enough to know
    // `newSession` (and the available_commands_update sent inside it) has
    // already completed.
    const stream = await fetch(`${server.url}/api/chat/stream`);
    const sse = new SseReader(stream);
    const done = sse.readUntil((e) => e.event === "chat-done");
    await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    await done;
    await sse.close();

    const response = await fetch(`${server.url}/api/agent/commands`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: SlashCommand[] };
    expect(body.commands).toEqual([
      { name: "outline", description: "從大綱建立投影片", source: "agent" },
      { name: "review", description: "檢查投影片內容", source: "agent" },
    ]);
  });

  it("before any message is sent, GET returns only what the skill directories contribute (agent has reported nothing yet)", async () => {
    // 出貨 skill 的目錄名本身就帶 `slidra-` 前綴（#248：名字要跟 agent
    // 註冊的一致），和 agent／使用者自己的 skill 區隔開來。
    await mkSkill(bundledDir, "slidra-plan", "---\nname: slidra-plan\ndescription: 出貨版\n---\n");
    const server = await serve(fakeAgent({ availableCommands: [{ name: "plan", description: "agent 版" }] }));

    const response = await fetch(`${server.url}/api/agent/commands`);
    const body = (await response.json()) as { commands: SlashCommand[] };
    expect(body.commands).toEqual([{ name: "slidra-plan", description: "出貨版", source: "bundled" }]);
  });

  it("no agent report and no skill directories at all: GET returns 200 with an empty list, not an error", async () => {
    const server = await serve(fakeAgent({}));
    const response = await fetch(`${server.url}/api/agent/commands`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: [] });
  });

  it("a later available_commands_update is broadcast over /api/events as 'agent-commands', with the freshly recomputed union", async () => {
    await mkSkill(userDir, "notes", "---\nname: notes\ndescription: 個人筆記\n---\n");
    // Deliberately no initial `availableCommands` here — this test isolates
    // the *later* report (mid-turn, via availableCommandsUpdateOnPromptIndex)
    // so there is exactly one `agent-commands` broadcast to read, not two.
    const server = await serve(
      fakeAgent({
        availableCommandsUpdateOnPromptIndex: 1,
        availableCommandsUpdate: [{ name: "outline", description: "更新後的描述" }],
        replies: [["(ack)"], ["好的"]],
      }),
    );

    const eventsStream = await fetch(`${server.url}/api/events`);
    const sse = new SseReader(eventsStream);
    const eventPromise = sse.readUntil((e) => e.event === "agent-commands");

    await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });

    const event = await eventPromise;
    expect(event.data).toEqual({
      commands: [
        { name: "notes", description: "個人筆記", source: "user" },
        { name: "outline", description: "更新後的描述", source: "agent" },
      ],
    });
    await sse.close();
  });
});
