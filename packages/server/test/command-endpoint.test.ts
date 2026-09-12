// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startServe, type RunningServer } from "../src/serve.js";
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
        name: "命令端點測試",
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

async function readProjectJson(presentationId: string): Promise<Record<string, unknown>> {
  const result = await runCli<Array<{ path: string; content: string }>>(["cat", presentationId, "project.json"]);
  expect(result.ok).toBe(true);
  return JSON.parse(Buffer.from(result.data![0]!.content, "base64").toString("utf-8"));
}

it("a whitelisted element move actually changes the slide and returns 200 with a CommandResult", async () => {
  const id = await openDeck("move.slidra");
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

it("a command outside the whitelist returns 403 and never reaches dispatch: the slide bytes are unchanged", async () => {
  const id = await openDeck("blacklist.slidra");
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

it("the four new commands slide delete/duplicate/move/notes set no longer return 403", async () => {
  const id = await openDeck("whitelist-page-management.slidra");
  const server = await serve(id);

  const notes = await postCommand(server, {
    name: "slide notes set",
    input: { slidePath: "slides/001.svg", text: "講稿" },
  });
  expect(notes.status).not.toBe(403);
  expect(notes.status).toBe(200);

  const duplicate = await postCommand(server, {
    name: "slide duplicate",
    input: { slidePath: "slides/001.svg" },
  });
  expect(duplicate.status).not.toBe(403);
  expect(duplicate.status).toBe(200);

  const move = await postCommand(server, {
    name: "slide move",
    input: { slidePath: "slides/002.svg", newIndex: 0 },
  });
  expect(move.status).not.toBe(403);
  expect(move.status).toBe(200);

  const del = await postCommand(server, {
    name: "slide delete",
    input: { slidePath: "slides/002.svg" },
  });
  expect(del.status).not.toBe(403);
  expect(del.status).toBe(200);
});

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

it("an oversized body → 400, and it never reaches dispatch", async () => {
  const id = await openDeck("big.slidra");
  const server = await serve(id);
  const before = await readSlide(id);

  const { status } = await postCommand(server, null, { raw: "x".repeat(200_000) });

  expect(status).toBe(400);
  expect(await readSlide(id)).toBe(before);
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

it("Origin: null is still blocked by the existing global gate — this route has no exception", async () => {
  const id = await openDeck("origin.slidra");
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

// The three "every whitelisted name is not 403" loop tests that used to
// live here (this one, plus the 14-command table loop and the 8-command
// chart loop below) have been deleted — merged into `slidra.test.ts`'s
// "COMMAND_WHITELIST ⇔ encoder key set are exactly equal" test, which
// asserts the same fact (every whitelisted name has an encoder, so none of
// them can 403) as a pure unit test that also proves each name encodes to
// a real argv, without spawning 43 subprocesses.

it("element resize is in COMMAND_WHITELIST and actually changes the slide", async () => {
  const id = await openDeck("resize.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "element resize",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], width: 100, height: 100, anchor: "nw" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('width="100" height="100"');
});

it("element delete and element duplicate are in COMMAND_WHITELIST and actually change the slide", async () => {
  const id = await openDeck("delete-duplicate.slidra");
  const server = await serve(id);

  const duplicated = await postCommand(server, {
    name: "element duplicate",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], dx: 5, dy: 5 },
  });
  expect(duplicated.status).toBe(200);
  expect(duplicated.json.ok).toBe(true);
  const afterDuplicate = await readSlide(id);
  expect(afterDuplicate).toContain('id="el-a"');
  expect((afterDuplicate.match(/<g id=/g) ?? []).length).toBe(2);

  const deleted = await postCommand(server, {
    name: "element delete",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"] },
  });
  expect(deleted.status).toBe(200);
  expect(await readSlide(id)).not.toContain('id="el-a"');
});

it("element name set is in COMMAND_WHITELIST and actually changes the slide (the panel caption lands as data-slidra-name)", async () => {
  const id = await openDeck("element-name-set.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "element name set",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], name: "封面影片" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('data-slidra-name="封面影片"');
});

it("template add/list/rename/delete are in COMMAND_WHITELIST and actually change project.json", async () => {
  const id = await openDeck("template-commands.slidra");
  const server = await serve(id);

  const added = await postCommand(server, {
    name: "template add",
    input: { from: "slides/001.svg", name: "封面" },
  });
  expect(added.status).toBe(200);
  expect(added.json.ok).toBe(true);
  const templatePath = added.json.data.templatePath as string;

  const listed = await postCommand(server, { name: "template list", input: {} });
  expect(listed.status).toBe(200);
  expect(listed.json.data.templates).toEqual([{ file: templatePath, name: "封面" }]);

  const renamed = await postCommand(server, {
    name: "template rename",
    input: { templatePath, newName: "封面（改）" },
  });
  expect(renamed.status).toBe(200);
  expect((await readProjectJson(id)).templates).toEqual([{ file: templatePath, name: "封面（改）" }]);

  const deleted = await postCommand(server, { name: "template delete", input: { templatePath } });
  expect(deleted.status).toBe(200);
  expect((await readProjectJson(id)).templates).toEqual([]);
});

it("element style set is in COMMAND_WHITELIST and actually changes the slide", async () => {
  const id = await openDeck("style-set.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "element style set",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], attr: "fill", value: "#c43e1c" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('fill="#c43e1c"');
});

it("table create is in COMMAND_WHITELIST and actually changes the slide", async () => {
  const id = await openDeck("table-create.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "table create",
    input: { slidePath: "slides/001.svg", rows: 2, cols: 2, x: 10, y: 10 },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('data-slidra-type="table"');
});

it("chart create is in COMMAND_WHITELIST and actually changes the slide", async () => {
  const id = await openDeck("chart-create.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "chart create",
    input: { slidePath: "slides/001.svg" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('data-slidra-type="chart"');
});

it("element style set given an attribute outside the whitelist is still rejected, slide bytes unchanged (transform/data-slidra-name)", async () => {
  const id = await openDeck("style-set-forbidden.slidra");
  const server = await serve(id);
  const before = await readSlide(id);

  const transformResult = await postCommand(server, {
    name: "element style set",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], attr: "transform", value: "translate(1 1)" },
  });
  expect(transformResult.status).not.toBe(200);

  const dataAttrResult = await postCommand(server, {
    name: "element style set",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], attr: "data-slidra-name", value: "x" },
  });
  expect(dataAttrResult.status).not.toBe(200);

  expect(await readSlide(id)).toBe(before);
});

async function openTextBoxDeck(fileName: string): Promise<string> {
  const { zipSync } = await import("fflate");
  const textBoxSlide =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
    '<g id="el-text" data-slidra-text-width="300"><text font-size="24" xml:space="preserve"><tspan x="0" y="24">Hi</tspan></text></g>' +
    "</svg>";
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        name: "文字框對齊測試",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode(textBoxSlide),
  });
  const slidraPath = path.join(slidraDir, fileName);
  await writeFile(slidraPath, zipped);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
  return opened.data!.id;
}

it("textbox align is in COMMAND_WHITELIST and actually changes the slide", async () => {
  const id = await openTextBoxDeck("textbox-align.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "textbox align",
    input: { slidePath: "slides/001.svg", elementId: "el-text", align: "center" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('data-slidra-text-align="center"');
});

it("slide style set is in COMMAND_WHITELIST and actually changes the slide", async () => {
  const id = await openDeck("slide-style-set.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "slide style set",
    input: { slidePath: "slides/001.svg", background: "#202020", accent: "#00ff00" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  const slide = await readSlide(id);
  expect(slide).toContain("background-color:#202020");
  expect(slide).toContain("--slidra-accent:#00ff00");
});

it("slide background set is in COMMAND_WHITELIST and actually changes the slide", async () => {
  const id = await openDeck("slide-background-set.slidra");
  const imported = await runCli<{ path: string }>([
    "asset", "import", id, "--svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"/>', "--name", "bg.svg",
  ]);
  expect(imported.ok).toBe(true);
  const server = await serve(id);

  const set = await postCommand(server, {
    name: "slide background set",
    input: { slidePath: "slides/001.svg", asset: "assets/bg.svg", opacity: 0.5 },
  });
  expect(set.status).toBe(200);
  expect(set.json.ok).toBe(true);
  const slide = await readSlide(id);
  expect(slide).toContain('data-slidra-role="background"');
  expect(slide).toContain('href="../assets/bg.svg"');
  expect(slide).toContain('opacity="0.5"');

  const cleared = await postCommand(server, {
    name: "slide background set",
    input: { slidePath: "slides/001.svg", none: true },
  });
  expect(cleared.status).toBe(200);
  expect(cleared.json.ok).toBe(true);
  expect(await readSlide(id)).not.toContain('data-slidra-role="background"');
});

it("presentation canvas set is in COMMAND_WHITELIST and actually changes project.json and the slide", async () => {
  const id = await openDeck("presentation-canvas-set.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "presentation canvas set",
    input: { width: 1024, height: 768 },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect((await readProjectJson(id)).canvas).toEqual({ width: 1024, height: 768 });
  expect(await readSlide(id)).toContain('viewBox="0 0 1024 768"');
});

it("slide transition set: a whitelisted value returns 2xx and is written into the slide SVG (replacing presentation transition set writing to project.json)", async () => {
  const id = await openDeck("transition-fade.slidra");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "slide transition set",
    input: { slidePath: "slides/001.svg", enter: "fade", enterDuration: 0.6 },
  });

  expect(status).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('enter="fade" enter-duration="0.6"');
});

it("slide transition set: an enter value outside the whitelist is rejected by the command layer, SVG unchanged", async () => {
  const id = await openDeck("transition-bad.slidra");
  const server = await serve(id);
  const before = await readSlide(id);

  const { status } = await postCommand(server, {
    name: "slide transition set",
    input: { slidePath: "slides/001.svg", enter: "spin" },
  });

  expect(status).not.toBe(200);
  expect(await readSlide(id)).toBe(before);
});

it("a single human action that changes multiple properties at once (dx and dy) still counts as one undo step: one undo reverts it all, a second undo does nothing", async () => {
  const id = await openDeck("undo-group.slidra");
  const server = await serve(id);
  const before = await readSlide(id);

  const { status } = await postCommand(server, {
    name: "element move",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], dx: 10, dy: -5 },
  });
  expect(status).toBe(200);
  expect(await readSlide(id)).toContain("translate(110 195)");

  const undoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
  expect(undoResponse.status).toBe(200);
  expect(await readSlide(id)).toBe(before);

  const secondUndoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
  expect(secondUndoResponse.status).toBe(400);
});
