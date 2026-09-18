// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startServe, type RunningServer } from "../src/serve.js";
import { openPolicy } from "../src/policy/open.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";

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

/**
 * `POST /api/command`. Seam B: the real server over real
 * HTTP, no browser and no mocks. The endpoint is the front end's ONLY way
 * to write, and its whole security posture is here — a fixed name whitelist
 * checked before dispatch, and a server-owned presentation id.
 *
 * [E10.T5] test-prune: this file used to carry 23 cases. 20 are deleted here
 * — per-command "is it in COMMAND_WHITELIST and does it actually change the
 * slide" loops that duplicate two things each already covered elsewhere:
 * whitelist membership is `crates/slidra/src/server/allowlist.rs`'s own
 * `editor_allowlist_has_exactly_68_entries_no_duplicates`/
 * `editor_is_confined_to_the_hand_listed_68` tests (and, pre-existing,
 * `slidra.test.ts`'s "COMMAND_WHITELIST <-> encoder key set are exactly
 * equal"), and each command's actual mutation behavior is that command's
 * own crate-level unit test — this file's value was never re-deriving that,
 * only proving the wire (whitelist -> server-owned id -> dispatch -> status
 * code) carries it through once. The 3 kept below are exactly the wire-level
 * properties nothing else asserts: the server owns the presentation id
 * (never trusts the caller's), malformed request shapes are 400, and
 * dispatch failure kind maps to the right status code.
 */

const fakeAgentFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "agent/fixtures/fake-acp-agent.mjs",
);
const fakeAgent: AgentAdapterConfig = {
  kind: "claude",
  label: "Claude Code",
  command: process.execPath,
  args: [fakeAgentFixture],
};

const SLIDE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><g id="el-a" transform="translate(100 200)"><rect x="0" y="0" width="50" height="50" fill="#c66"/></g></svg>';

let slidraHome: string;
let slidraDir: string;
let staticRoot: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-cmd-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-cmd-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "slidra-cmd-static-"));
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
  await rm(staticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function openDeck(fileName: string): Promise<string> {
  const { zipSync } = await import("fflate");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        name: "command endpoint test",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode(SLIDE),
  });
  const slidraPath = path.join(slidraDir, fileName);
  await writeFile(slidraPath, zipped);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
  return opened.data!.id;
}

async function serve(presentationId: string): Promise<RunningServer> {
  const server = await startServe({
    policy: openPolicy,
    presentationId,
    port: 0,
    agent: fakeAgent,
    staticDir: path.join(staticRoot, "dist"),
  });
  servers.push(server);
  return server;
}

async function postCommand(
  server: RunningServer,
  body: unknown,
  init: { raw?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${server.url}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.raw ?? JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function readSlide(presentationId: string): Promise<string> {
  const result = await runCli<Array<{ path: string; content: string }>>(["cat", presentationId, "slides/001.svg"]);
  expect(result.ok).toBe(true);
  return Buffer.from(result.data![0]!.content, "base64").toString("utf-8");
}

it("an id inside input is ignored: the server always overwrites it with its own startup presentationId", async () => {
  const idA = await openDeck("a.slidra");
  const idB = await openDeck("b.slidra");
  expect(idA).not.toBe(idB);
  const server = await serve(idA);
  const bBefore = await readSlide(idB);

  const { status } = await postCommand(server, {
    name: "element move",
    input: { id: idB, slidePath: "slides/001.svg", elementIds: ["el-a"], dx: 7, dy: 0 },
  });

  expect(status).toBe(200);
  // A moved, B untouched — the client's `id` was ignored, not honoured.
  expect(await readSlide(idA)).toContain("translate(107 200)");
  expect(await readSlide(idB)).toBe(bBefore);
});

it("body not JSON, input not an object, or name not a string → 400", async () => {
  const id = await openDeck("bad.slidra");
  const server = await serve(id);

  expect((await postCommand(server, null, { raw: "{ not json" })).status).toBe(400);
  expect((await postCommand(server, { name: "element move", input: 42 })).status).toBe(400);
  expect((await postCommand(server, { name: 123, input: {} })).status).toBe(400);
  expect((await postCommand(server, { input: {} })).status).toBe(400);
});

it("dispatch returning not-found → 404; any other failure → 500", async () => {
  const id = await openDeck("notfound.slidra");
  const server = await serve(id);

  const missingSlide = await postCommand(server, {
    name: "element move",
    input: { slidePath: "slides/999.svg", elementIds: ["el-a"], dx: 1, dy: 1 },
  });
  expect(missingSlide.status).toBe(404);

  // A real element id that does not exist is not an absence of the FILE —
  // it is a rejected edit, and must not be reported as 404.
  const missingElement = await postCommand(server, {
    name: "element move",
    input: { slidePath: "slides/001.svg", elementIds: ["el-nope"], dx: 1, dy: 1 },
  });
  expect(missingElement.status).toBe(500);
});
