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
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

async function readProjectJson(presentationId: string): Promise<Record<string, unknown>> {
  const result = await registry.dispatch<{ content: string }>("cat", {
    id: presentationId,
    path: "project.json",
  });
  return JSON.parse(result.data!.content);
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

it("[E2.T3] slide delete／duplicate／move／notes set 四條新命令不再回 403", async () => {
  const id = await openDeck("whitelist-page-management.comot");
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

it("白名單內的命令都不會被擋在 403（NOOP-141 的常用分頁按鈕新增的九條、NOOP-144 的 text set 也在內）", async () => {
  const id = await openDeck("whitelist.comot");
  const server = await serve(id);

  for (const name of [
    "element move",
    "element scale",
    "element rotate",
    "textbox width",
    "text set",
    "slide add",
    "element copy",
    "element cut",
    "element paste",
    "element insert",
    "textbox add",
    "element align",
    "element distribute",
    "element order",
    // [E2.T11]: replaces `presentation transition set` (removed).
    "slide transition set",
    "element resize",
    "element delete",
    "element duplicate",
  ]) {
    const { status } = await postCommand(server, { name, input: { slidePath: "slides/001.svg", name: "fade", enter: "fade" } });
    expect(status, `${name} 不應該被白名單擋下`).not.toBe(403);
  }
});

it("NOOP-90/T2：element resize 在 COMMAND_WHITELIST 內，會實際改到投影片", async () => {
  const id = await openDeck("resize.comot");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "element resize",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], width: 100, height: 100, anchor: "nw" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('width="100" height="100"');
});

it("NOOP-90/T2：element delete 與 element duplicate 在 COMMAND_WHITELIST 內，會實際改到投影片", async () => {
  const id = await openDeck("delete-duplicate.comot");
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

it("[E4.T7]：template add/list/rename/delete 在 COMMAND_WHITELIST 內，會實際改到 project.json", async () => {
  const id = await openDeck("template-commands.comot");
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

it("NOOP-143：element style set 在 COMMAND_WHITELIST 內，會實際改到投影片", async () => {
  const id = await openDeck("style-set.comot");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "element style set",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], attr: "fill", value: "#c43e1c" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('fill="#c43e1c"');
});

it("E2.T12：圖表的八條命令都在 COMMAND_WHITELIST 內，不會被擋在 403", async () => {
  const id = await openDeck("chart-whitelist.comot");
  const server = await serve(id);

  for (const name of [
    "chart create",
    "chart data set",
    "chart type set",
    "chart palette set",
    "chart axis set",
    "chart stack set",
    "chart legend set",
    "chart option set",
  ]) {
    const { status } = await postCommand(server, { name, input: { slidePath: "slides/001.svg" } });
    expect(status, `${name} 不應該被白名單擋下`).not.toBe(403);
  }
});

it("E2.T12：chart create 在 COMMAND_WHITELIST 內，會實際改到投影片", async () => {
  const id = await openDeck("chart-create.comot");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "chart create",
    input: { slidePath: "slides/001.svg" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('data-comot-type="chart"');
});

it("#200 §5-E：element style set 收到白名單外的屬性仍被拒絕，投影片位元組不變（transform／data-comot-name）", async () => {
  const id = await openDeck("style-set-forbidden.comot");
  const server = await serve(id);
  const before = await readSlide(id);

  const transformResult = await postCommand(server, {
    name: "element style set",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], attr: "transform", value: "translate(1 1)" },
  });
  expect(transformResult.status).not.toBe(200);

  const dataAttrResult = await postCommand(server, {
    name: "element style set",
    input: { slidePath: "slides/001.svg", elementIds: ["el-a"], attr: "data-comot-name", value: "x" },
  });
  expect(dataAttrResult.status).not.toBe(200);

  expect(await readSlide(id)).toBe(before);
});

async function openTextBoxDeck(fileName: string): Promise<string> {
  const { zipSync } = await import("fflate");
  const textBoxSlide =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
    '<g id="el-text" data-comot-text-width="300"><text font-size="24" xml:space="preserve"><tspan x="0" y="24">Hi</tspan></text></g>' +
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
  const comotPath = path.join(comotDir, fileName);
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

it("#200：textbox align 在 COMMAND_WHITELIST 內，會實際改到投影片", async () => {
  const id = await openTextBoxDeck("textbox-align.comot");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "textbox align",
    input: { slidePath: "slides/001.svg", elementId: "el-text", align: "center" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(await readSlide(id)).toContain('data-comot-text-align="center"');
});

it("#200：slide style set 在 COMMAND_WHITELIST 內，會實際改到投影片", async () => {
  const id = await openDeck("slide-style-set.comot");
  const server = await serve(id);

  const { status, json } = await postCommand(server, {
    name: "slide style set",
    input: { slidePath: "slides/001.svg", background: "#202020", accent: "#00ff00" },
  });

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  const slide = await readSlide(id);
  expect(slide).toContain("background-color:#202020");
  expect(slide).toContain("--comot-accent:#00ff00");
});

it("#200：presentation canvas set 在 COMMAND_WHITELIST 內，會實際改到 project.json 與投影片", async () => {
  const id = await openDeck("presentation-canvas-set.comot");
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

it("[A8] slide transition set：白名單內的合法值回 2xx，並寫進投影片 SVG（取代 presentation transition set 寫 project.json）", async () => {
  const id = await openDeck("transition-fade.comot");
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

it("slide transition set：白名單外的 enter 值被命令層拒絕，SVG 不變", async () => {
  const id = await openDeck("transition-bad.comot");
  const server = await serve(id);
  const before = await readSlide(id);

  const { status } = await postCommand(server, {
    name: "slide transition set",
    input: { slidePath: "slides/001.svg", enter: "spin" },
  });

  expect(status).not.toBe(200);
  expect(await readSlide(id)).toBe(before);
});

it("一次人類操作即使同時改變多個屬性（dx 與 dy），也只佔一格復原：一次 undo 就整個復原，第二次 undo 落空", async () => {
  const id = await openDeck("undo-group.comot");
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
