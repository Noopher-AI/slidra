// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startServe } from "../../src/serve.js";
import type { RunningServer } from "../../src/serve.js";
import { openPolicy } from "../../src/policy/open.js";
import type { AgentAdapterConfig } from "../../src/agent/session.js";
import { requireCliBuilt } from "./require-cli-built.js";

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

// T5: the agent-turn/undo-group/freeze contract, driven over
// HTTP with a real subprocess fake ACP agent — same Seam B discipline as
// chat.test.ts, never the real Claude Code/Codex, never a mock of
// AgentChatSession or history.ts itself.

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/multi-command-fake-acp-agent.mjs",
);

let slidraHome: string;
let slidraDir: string;
let logDir: string;
let logPath: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-freeze-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-freeze-files-"));
  logDir = await mkdtemp(path.join(tmpdir(), "slidra-freeze-log-"));
  logPath = path.join(logDir, "fake-agent.log.jsonl");
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
  await rm(logDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * [E6.T6]: undo history now lives inside the deck's own `.slidra` file
 * (`history_group`/`history_entry`/`history_snapshot` tables next to
 * `content` — `crates/slidra/src/deck.rs`), not under
 * `<SLIDRA_HOME>/history/<id>/`. `node:sqlite`'s `DatabaseSync` is used
 * here the same test-only way `e2e/helpers/deck.ts`/`serve.test.ts` already
 * use it — the server and CLI themselves never read/write a deck this way.
 */
/** True only for "the history tables don't exist yet" (never edited) — every other failure (e.g. SQLITE_BUSY) must surface, not be read as "0"/"false". */
function isMissingHistoryTable(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no such table");
}

async function undoGroupCount(deckPath: string): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath, { readOnly: true });
  // Now that a real read failure surfaces instead of being read as "0"
  // (see isMissingHistoryTable below), a momentary SQLITE_BUSY against the
  // server's own concurrent write must be waited out, not thrown on sight —
  // without this the readonly connection's default (fail immediately) turns
  // ordinary write/read overlap into a flaky "database is locked" error.
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM history_group WHERE stack = 0").get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  } catch (error) {
    // No history tables yet (never edited) — an empty undo stack. Anything
    // else (e.g. SQLITE_BUSY on a concurrent writer) must not be swallowed
    // into a falsely-passing "0": that is what made `expected +0 to be 2`
    // unreadable — it could mean either "really zero" or "couldn't read".
    if (isMissingHistoryTable(error)) return 0;
    throw error;
  } finally {
    db.close();
  }
}

async function hasOpenHistoryGroup(deckPath: string): Promise<boolean> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM history_group WHERE stack = 2").get() as
      | { n: number }
      | undefined;
    return (row?.n ?? 0) > 0;
  } catch (error) {
    if (isMissingHistoryTable(error)) return false;
    throw error;
  } finally {
    db.close();
  }
}

/** Wipes the deck's history side tables directly — the SQLite-table equivalent of the pre-[E6.T6] `rm(<SLIDRA_HOME>/history/<id>)`. */
async function clearDeckHistory(deckPath: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath);
  try {
    for (const table of ["history_entry", "history_group", "history_snapshot"]) {
      try {
        db.prepare(`DELETE FROM ${table}`).run();
      } catch {
        // Table does not exist yet — nothing to clear.
      }
    }
  } finally {
    db.close();
  }
}

async function openFreshPresentationWithElement(): Promise<{ id: string; elementId: string; deckPath: string }> {
  const slidraPath = path.join(slidraDir, "deck.slidra");
  const created = await runCli(["new", slidraPath, "--name", "Test Presentation"]);
  expect(created.ok).toBe(true);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
  // `new` creates no slides: mint one page with one text
  // box, and take the element id straight from `textbox add`'s own result.
  const id = opened.data!.id;
  expect((await runCli(["slide", "add", id])).ok).toBe(true);
  const added = await runCli<{ elementId: string }>([
    "textbox", "add", id, "slides/001.svg", "--x", "80", "--y", "80", "--width", "600", "--text", "Title",
  ]);
  expect(added.ok).toBe(true);
  // These tests count undo entries, and the two setup commands above leave
  // their own. Drop the history so the deck reaches each test exactly as it
  // did when `new` still shipped a first slide: one page, empty undo stack.
  // `slidraPath` IS the deck's real path (`new`/`open` operate on it directly).
  await clearDeckHistory(slidraPath);
  return { id, elementId: added.data!.elementId, deckPath: slidraPath };
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
  const server = await startServe({ policy: openPolicy, presentationId, port: 0, agent });
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

/**
 * Polls the fake agent's log until `predicate` matches a line, or `timeoutMs` elapses.
 * Default matches this file's own vi.setConfig testTimeout (60s, with a 5s margin
 * under it): this is a self-timed poll loop, so raising the vitest-level budget alone
 * does not help it survive full-suite CPU contention or macOS's slower subprocess
 * spawns — it needs matching headroom applied here directly.
 */
async function waitForLog(predicate: (line: LogLine) => boolean, timeoutMs = 55_000): Promise<LogLine> {
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

/** Polls GET /api/editing until `frozen` matches. Same rationale as waitForLog above. */
async function waitForFrozen(server: RunningServer, frozen: boolean, timeoutMs = 55_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await getEditingState(server);
    if (state.frozen === frozen) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for frozen === ${frozen}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * `waitForFrozen(server, false)` observes the unfreeze over HTTP; the history-group
 * close it unblocks is a separate SQLite write on the same async path, so under
 * heavier CI load the two can be observed out of order — `frozen` flips visible a
 * moment before the group-close write lands. Give a read that depends on the write
 * a short settle window instead of asserting the instant the poll above returns.
 */
async function waitForCount(fn: () => Promise<number>, expected: number, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value === expected || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readSlide(id: string): Promise<string> {
  const result = await runCli<Array<{ path: string; content: string }>>(["cat", id, "slides/001.svg"]);
  expect(result.ok).toBe(true);
  return Buffer.from(result.data![0]!.content, "base64").toString("utf-8");
}

async function listAssets(id: string): Promise<string[]> {
  const result = await runCli<{ entries: string[] }>(["ls", id, "assets"]);
  expect(result.ok).toBe(true);
  return result.data!.entries;
}

/**
 * Extracts the `<g id="elementId">...</g>` block for one element, so a
 * "did this element change" check doesn't depend on any other element in
 * the slide staying byte-identical (the agent's own in-flight
 * `text set` targets a different element and can legitimately land inside
 * the same window, which a whole-document diff can't tell apart from one
 * of the rejected commands actually running).
 */
function extractElementBlock(content: string, elementId: string): string {
  const match = new RegExp(`<g id="${elementId}"[\\s\\S]*?</g>`).exec(content);
  if (!match) throw new Error(`element ${elementId} not found in slide content`);
  return match[0];
}

interface CommandExecutionFixture {
  id: string;
  elementId: string;
  moveElementId: string;
  scaleElementId: string;
  rotateElementId: string;
  textboxElementId: string;
}

/**
 * `openFreshPresentationWithElement`'s lone `<text>`
 * title is a bare primitive outside any `<g>` — `element insert`/`requireContainer`
 * refuse to touch a slide in that shape at all (ADR-0008 compliance), and
 * move/scale/rotate only ever match a `<g>` besides. `convert` repairs the
 * slide into the compliant container form first (lifting the title's id
 * onto its new wrapping `<g>`, so `elementId` still resolves), then this adds
 * one `<g>`-backed rect per transform command plus a real text box, letting
 * the post-unfreeze assertions prove each command's actual effect, not just
 * its status code.
 */
async function openFreshPresentationForCommandExecution(): Promise<CommandExecutionFixture> {
  const { id, elementId } = await openFreshPresentationWithElement();
  const slidePath = "slides/001.svg";
  const converted = await runCli(["convert", id]);
  expect(converted.ok).toBe(true);

  const move = await runCli<{ elementId: string }>([
    "element", "insert", "rect", id, slidePath, "--x", "100", "--y", "200", "--width", "50", "--height", "50",
  ]);
  const scale = await runCli<{ elementId: string }>([
    "element", "insert", "rect", id, slidePath, "--x", "300", "--y", "300", "--width", "50", "--height", "50",
  ]);
  const rotate = await runCli<{ elementId: string }>([
    "element", "insert", "rect", id, slidePath, "--x", "50", "--y", "60", "--width", "20", "--height", "20",
  ]);
  const textbox = await runCli<{ elementId: string }>([
    "textbox", "add", id, slidePath, "--x", "10", "--y", "10", "--width", "200", "--text", "hello",
  ]);
  expect(move.ok).toBe(true);
  expect(scale.ok).toBe(true);
  expect(rotate.ok).toBe(true);
  expect(textbox.ok).toBe(true);

  return {
    id,
    elementId,
    moveElementId: move.data!.elementId,
    scaleElementId: scale.data!.elementId,
    rotateElementId: rotate.data!.elementId,
    textboxElementId: textbox.data!.elementId,
  };
}

describe("T5: agent-turn undo grouping and editing freeze", () => {
  beforeAll(requireCliBuilt);
  // Each test here spawns several `slidra` CLI subprocesses via execFile and
  // polls over real HTTP; the shared vitest.config.ts budget (30s) was tuned
  // against Linux CI contention and left near-zero headroom for this file's
  // own internal poll timeouts (also 30s, see waitForLog/waitForFrozen
  // above). On the macOS runner (first exercised by [E6.T11]'s new
  // required-macos job) subprocess spawn overhead alone pushes some of these
  // right past the shared budget — "AC4" finished at 30042ms, 42ms over,
  // not hung. Doubling this file's own timeout gives real margin without
  // masking an actual hang (still well under e2e's 120s ceiling).
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  it("AC1: one turn's several commands undo together as a single group, and a second undo hits the empty stack", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const originalContent = await readSlide(id);
    const commands = [
      `slidra text set ${id} slides/001.svg ${elementId} 'first'`,
      `slidra text set ${id} slides/001.svg ${elementId} 'second'`,
      `slidra text set ${id} slides/001.svg ${elementId} 'third'`,
    ];
    const server = await serve(fakeAgent({ commandsPerTurn: [commands] }), id);

    const chatResponse = await postChat(server, "change the title three times");
    expect(chatResponse.status).toBe(202);
    await waitForLog((line) => line.ranCommand === commands[2]);
    await waitForFrozen(server, false);

    const editedContent = await readSlide(id);
    expect(editedContent).toContain("third");
    expect(editedContent).not.toBe(originalContent);

    const undoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(undoResponse.status).toBe(200);
    const restoredContent = await readSlide(id);
    expect(restoredContent).toBe(originalContent);

    const secondUndoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(secondUndoResponse.status).toBe(400);
    const body = (await secondUndoResponse.json()) as { error: string };
    expect(body.error).toBe("no operation to undo");
  });

  it("AC2-a: after the turn, the deck's history tables have no open group and exactly one undo entry for it", async () => {
    const { id, elementId, deckPath } = await openFreshPresentationWithElement();
    const commands = [
      `slidra text set ${id} slides/001.svg ${elementId} 'A'`,
      `slidra text set ${id} slides/001.svg ${elementId} 'B'`,
    ];
    const server = await serve(fakeAgent({ commandsPerTurn: [commands] }), id);

    await postChat(server, "change the title");
    await waitForLog((line) => line.ranCommand === commands[1]);
    await waitForFrozen(server, false);

    expect(await hasOpenHistoryGroup(deckPath)).toBe(false);
    expect(await waitForCount(() => undoGroupCount(deckPath), 1)).toBe(1);
  });

  it("two separate agent turns produce two separate undo groups", async () => {
    const { id, elementId, deckPath } = await openFreshPresentationWithElement();
    const cmd1 = `slidra text set ${id} slides/001.svg ${elementId} 'round-one'`;
    const cmd2 = `slidra text set ${id} slides/001.svg ${elementId} 'round-two'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[cmd1], [cmd2]] }), id);

    await postChat(server, "first request");
    await waitForLog((line) => line.ranCommand === cmd1);
    await waitForFrozen(server, false);

    await postChat(server, "second request");
    await waitForLog((line) => line.ranCommand === cmd2);
    await waitForFrozen(server, false);

    expect(await waitForCount(() => undoGroupCount(deckPath), 2)).toBe(2);
  });

  it("AC2-b: a turn that only reads (thinks) never freezes, and undo requests during it are never 409'd", async () => {
    const { id } = await openFreshPresentationWithElement();
    const server = await serve(fakeAgent({ commandsPerTurn: [], readOnlyTurns: [0] }), id);

    await postChat(server, "take a look at the slides first");
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
    const command = `slidra text set ${id} slides/001.svg ${elementId} 'edit-once'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    await postChat(server, "change the title");
    await waitForLog((line) => line.permissionOutcome !== undefined);

    expect((await getEditingState(server)).frozen).toBe(true);
    const duringTurn = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(duringTurn.status).toBe(409);
    const duringBody = (await duringTurn.json()) as { error: string };
    expect(duringBody.error).toBe("The agent is currently editing, please wait.");

    await waitForFrozen(server, false);
    const afterTurn = await fetch(`${server.url}/api/undo`, { method: "POST" });
    expect(afterTurn.status).toBe(200);
  });

  it("AC4: the agent's first command waits for an in-progress human edit instead of failing", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const originalContent = await readSlide(id);
    const command = `slidra text set ${id} slides/001.svg ${elementId} 'edited-after-release'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    const beginResponse = await fetch(`${server.url}/api/editing/begin`, { method: "POST" });
    expect(beginResponse.status).toBe(200);

    await postChat(server, "change the title");
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
    expect(await readSlide(id)).toContain("edited-after-release");
  });

  it("POST /api/editing/begin is refused with 409 while the agent holds the floor", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const command = `slidra text set ${id} slides/001.svg ${elementId} 'change the title'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    await postChat(server, "change the title");
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

  it("POST /api/command: T2's four whitelisted commands are all refused with 409 while the agent holds the floor, then actually execute once it releases", async () => {
    const { id, elementId, moveElementId, scaleElementId, rotateElementId, textboxElementId } =
      await openFreshPresentationForCommandExecution();
    const command = `slidra text set ${id} slides/001.svg ${elementId} 'change the title'`;
    // Keep the agent's lock open long enough for all four concurrent HTTP
    // requests to reach the server. Without this deliberate fixture pause,
    // the real release CLI can finish the agent command between the test's
    // frozen-state assertion and the requests under full-suite contention.
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]], holdAfterPermissionMs: 200 }), id);
    const slidePath = "slides/001.svg";

    const payloads: Array<{ name: string; input: Record<string, unknown> }> = [
      { name: "element move", input: { slidePath, elementIds: [moveElementId], dx: 10, dy: -5 } },
      { name: "element scale", input: { slidePath, elementIds: [scaleElementId], factor: 2 } },
      { name: "element rotate", input: { slidePath, elementIds: [rotateElementId], degrees: 30 } },
      { name: "textbox width", input: { slidePath, elementId: textboxElementId, width: 100 } },
    ];

    await postChat(server, "change the title");
    await waitForLog((line) => line.permissionOutcome !== undefined);
    expect((await getEditingState(server)).frozen).toBe(true);

    const rejectedElementIds = [moveElementId, scaleElementId, rotateElementId, textboxElementId];
    const frozenSlide = await readSlide(id);
    const frozenBlocks = rejectedElementIds.map((elId) => extractElementBlock(frozenSlide, elId));
    // Fired concurrently, not one-by-one: the agent's own command now runs
    // in milliseconds (the Rust CLI binary, not Node), so the freeze window
    // this loop needs to land inside of is short enough that four
    // sequential round trips could straddle the unfreeze — one becoming a
    // false negative regardless of whether the 409 gate itself is correct.
    const rejectionResponses = await Promise.all(
      payloads.map(({ name, input }) =>
        fetch(`${server.url}/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, input }),
        }),
      ),
    );
    for (const [i, response] of rejectionResponses.entries()) {
      expect(response.status, `${payloads[i].name} should be blocked during the freeze window`).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("The agent is currently editing, please wait.");
    }
    // The 409 refusal must be a real refusal, not a "runs anyway": none of
    // the four elements targeted by the rejected calls above moved. Scoped
    // to just those elements rather than the whole slide, because the
    // agent's own in-flight `text set` (a different element) can land
    // during this same window without that being a freeze violation.
    const rejectedSlide = await readSlide(id);
    rejectedElementIds.forEach((elId, i) => {
      expect(extractElementBlock(rejectedSlide, elId), `${elId} should retain its pre-freeze content`).toBe(frozenBlocks[i]);
    });

    await waitForFrozen(server, false);

    // Once the turn releases the lock, each whitelisted command must not
    // just avoid 409 — it must actually run, the way it does in
    // command-endpoint.test.ts, and leave the effect in the SVG.
    for (const { name, input } of payloads) {
      const response = await fetch(`${server.url}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, input }),
      });
      expect(response.status, `${name} should execute normally after unfreezing`).toBe(200);
    }

    const executedSlide = await readSlide(id);
    expect(executedSlide).toContain(`<g id="${moveElementId}" transform="translate(110 195)">`);
    expect(executedSlide).toMatch(
      new RegExp(`<g id="${scaleElementId}"[^>]*><rect[^>]*width="100"[^>]*height="100"`),
    );
    expect(executedSlide).toContain(`<g id="${rotateElementId}" transform="translate(50 60) rotate(30)">`);
    expect(executedSlide).toContain(`data-slidra-text-width="100"`);
  });

  it("POST /api/asset: refused with 409 while the agent holds the floor, then actually runs once it releases", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const command = `slidra text set ${id} slides/001.svg ${elementId} 'change the title'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);
    const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

    await postChat(server, "change the title");
    await waitForLog((line) => line.permissionOutcome !== undefined);
    expect((await getEditingState(server)).frozen).toBe(true);

    const frozenResponse = await fetch(`${server.url}/api/asset`, {
      method: "POST",
      headers: { "X-Slidra-Asset-Name": "photo.png" },
      body: pngBytes,
    });
    expect(frozenResponse.status).toBe(409);
    const frozenBody = (await frozenResponse.json()) as { error: string };
    expect(frozenBody.error).toBe("The agent is currently editing, please wait.");
    expect(await listAssets(id)).toEqual([]);

    await waitForFrozen(server, false);

    const unfrozenResponse = await fetch(`${server.url}/api/asset`, {
      method: "POST",
      headers: { "X-Slidra-Asset-Name": "photo.png" },
      body: pngBytes,
    });
    expect(unfrozenResponse.status).toBe(200);
    expect(await listAssets(id)).toEqual(["photo.png"]);
  });

  it("browsing endpoints are unaffected while frozen: GET /api/presentation and GET /api/files/* keep working", async () => {
    const { id, elementId } = await openFreshPresentationWithElement();
    const command = `slidra text set ${id} slides/001.svg ${elementId} 'change the title'`;
    const server = await serve(fakeAgent({ commandsPerTurn: [[command]] }), id);

    await postChat(server, "change the title");
    await waitForLog((line) => line.permissionOutcome !== undefined);
    expect((await getEditingState(server)).frozen).toBe(true);

    const presentationResponse = await fetch(`${server.url}/api/presentation`);
    expect(presentationResponse.status).toBe(200);
    const fileResponse = await fetch(`${server.url}/api/files/${encodeURIComponent("slides/001.svg")}`);
    expect(fileResponse.status).toBe(200);

    await waitForFrozen(server, false);
  });
});
