import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe, type RunningServer } from "../src/serve.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";

/**
 * `POST /api/command` (NOOP-91 §4.9). Seam B: the real server over real
 * HTTP, no browser and no mocks. The endpoint is the front end's ONLY way
 * to write, and its whole security posture is here — a four-name whitelist
 * checked before dispatch, and a server-owned presentation id.
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

let coMotionHome: string;
let comotDir: string;
let staticRoot: string;
let registry: CommandRegistry;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-cmd-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-cmd-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "co-motion-cmd-static-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
  await rm(staticRoot, { recursive: true, force: true });
});

async function openDeck(fileName: string): Promise<string> {
  const { zipSync } = await import("fflate");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        name: "命令端點測試",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode(SLIDE),
  });
  const comotPath = path.join(comotDir, fileName);
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function serve(presentationId: string): Promise<RunningServer> {
  const server = await startServe({
    registry,
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
  const result = await registry.dispatch<{ content: string }>("cat", {
    id: presentationId,
    path: "slides/001.svg",
  });
  return result.data!.content;
}

it("白名單內的 element move 會實際改到投影片，並回 200 與 CommandResult", async () => {
  const id = await openDeck("move.comot");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "element move",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], dx: 10, dy: -5 },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(typeof json.message).toBe("string");
  expect(await readSlide(id)).toContain("translate(110 195)");
});

it("白名單外的命令回 403，而且根本不會進 dispatch：投影片位元組不變", async () => {
  const id = await openDeck("blacklist.comot");
  const server = await serve(id);
  const before = await readSlide(id);

  const { status, json } = await postCommand(server, {
    name: "open",
    input: { path: "/etc/passwd" },
  });

  expect(status).toBe(403);
  expect(json.error).toContain("open");
  expect(await readSlide(id)).toBe(before);
});

it("input 帶了自己的 id 也沒用：server 一律覆寫成自己啟動時的 presentationId", async () => {
  const idA = await openDeck("a.comot");
  const idB = await openDeck("b.comot");
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

it("body 不是 JSON、input 不是物件、name 不是字串 → 400", async () => {
  const id = await openDeck("bad.comot");
  const server = await serve(id);

  expect((await postCommand(server, null, { raw: "{ not json" })).status).toBe(400);
  expect((await postCommand(server, { name: "element move", input: 42 })).status).toBe(400);
  expect((await postCommand(server, { name: 123, input: {} })).status).toBe(400);
  expect((await postCommand(server, { input: {} })).status).toBe(400);
});

it("body 超過上限 → 400，且不會進 dispatch", async () => {
  const id = await openDeck("big.comot");
  const server = await serve(id);
  const before = await readSlide(id);

  const { status } = await postCommand(server, null, { raw: "x".repeat(200_000) });

  expect(status).toBe(400);
  expect(await readSlide(id)).toBe(before);
});

it("dispatch 回 not-found → 404；其餘失敗 → 500", async () => {
  const id = await openDeck("notfound.comot");
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

it("Origin: null 仍被既有的全域閘門擋下，這條路由沒有例外", async () => {
  const id = await openDeck("origin.comot");
  const server = await serve(id);
  const before = await readSlide(id);

  const { status } = await postCommand(
    server,
    { name: "element move", input: { slidePath: "slides/001.svg", elementIds: ["el-a"], dx: 3, dy: 3 } },
    { headers: { Origin: "null" } },
  );

  expect(status).toBe(403);
  expect(await readSlide(id)).toBe(before);
});

it("四個白名單命令都不會被擋在 403（textbox width / element scale / element rotate 也在內）", async () => {
  const id = await openDeck("whitelist.comot");
  const server = await serve(id);

  for (const name of ["element move", "element scale", "element rotate", "textbox width"]) {
    const { status } = await postCommand(server, { name, input: { slidePath: "slides/001.svg" } });
    expect(status, `${name} 不應該被白名單擋下`).not.toBe(403);
  }
});
