import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";

// Resolves the same packages/web/dist directory startServe's own
// resolveWebDist() computes, so the static-serving tests can populate a
// real build there without touching serve.ts's internals.
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

// None of the tests in this file touch /api/chat*, and spawning is lazy
// (first sendMessage), so this fixture is never actually spawned here —
// it exists only to satisfy the now-required `agent` field on ServeOptions
// (ticket #6, fix 6: "serve without an agent" is unrepresentable).
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

// Seam B: start the real server, drive it over HTTP, never open a browser.
// Every test points CO_MOTION_HOME at its own temp directory (ADR-0004
// testing convention) and always binds port 0, reading the assigned port
// back — a fixed port would collide with ticket #6's own server tests.

let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-serve-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-serve-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
});

afterEach(async () => {
  // Always shut every server started in the test down, including on
  // failure, or the suite hangs on an open listening socket.
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

async function openFreshPresentation(name = "測試簡報"): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function serve(presentationId: string, overrides: Partial<Parameters<typeof startServe>[0]> = {}) {
  const server = await startServe({ registry, presentationId, port: 0, agent: fakeAgent, ...overrides });
  servers.push(server);
  return server;
}

// Builds a hostile .comot with a literal project.json body (bypassing the
// server's own JSON.stringify) so the malformed-container tests exercise
// the exact bytes the review found unhandled — real fflate zips, no mocks.
//
// Ticket #12: `open` now runs the same structural validation `serve` used
// to run on its own, so a structurally invalid project.json is rejected
// right here, before any id or work directory exists for it — it never
// reaches `serve()` at all. This returns `open`'s own rejection message
// (and asserts the dispatch failed) instead of an id.
async function openMalformedPresentation(projectJsonRaw: string): Promise<string> {
  const { zipSync } = await import("fflate");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(projectJsonRaw),
    "slides/": new Uint8Array(0),
    "assets/": new Uint8Array(0),
  });
  const malformedPath = path.join(comotDir, "malformed.comot");
  await writeFile(malformedPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: malformedPath });
  expect(opened.ok).toBe(false);
  return opened.message;
}

describe("startServe", () => {
  it("binds port 0 and reports back the actual assigned port", async () => {
    const id = await openFreshPresentation();

    const server = await serve(id);

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("serves the presentation's metadata reached only through registry.dispatch", async () => {
    const id = await openFreshPresentation("我的簡報");

    const server = await serve(id);
    const response = await fetch(`${server.url}/api/presentation`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.name).toBe("我的簡報");
    expect(body.slides).toEqual(["slides/001.svg"]);
  });

  it("serves a slide's SVG content that matches what `cat` returns through the same dispatch", async () => {
    const id = await openFreshPresentation();
    const expected = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });

    const server = await serve(id);
    const response = await fetch(`${server.url}/api/files/slides/001.svg`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(body).toBe(expected.data!.content);
  });

  it("reaches presentation content only through registry.dispatch, never the filesystem directly", async () => {
    // A registry with stub handlers and no real presentation on disk at all
    // (CO_MOTION_HOME is empty). If the server can still return this stub's
    // content, that structurally proves it never reads files itself.
    const calls: string[] = [];
    const stubRegistry = new CommandRegistry();
    stubRegistry.register("cat", {
      handler: async (input: unknown) => {
        const { path: virtualPath } = input as { path: string };
        calls.push(virtualPath);
        if (virtualPath === "project.json") {
          return {
            ok: true,
            data: {
              content: JSON.stringify({
                formatVersion: 1,
                name: "Stub",
                canvas: { width: 1, height: 1 },
                slides: ["slides/fake.svg"],
              }),
            },
            message: "",
          };
        }
        if (virtualPath === "slides/fake.svg") {
          return { ok: true, data: { content: "<svg>STUB</svg>" }, message: "" };
        }
        return { ok: false, message: `找不到檔案：${virtualPath}` };
      },
      render: null,
    });

    const server = await serve("unregistered-stub-id", { registry: stubRegistry });

    const meta = await (await fetch(`${server.url}/api/presentation`)).json();
    expect(meta.slides).toEqual(["slides/fake.svg"]);

    const slide = await (await fetch(`${server.url}/api/files/slides/fake.svg`)).text();
    expect(slide).toBe("<svg>STUB</svg>");

    expect(calls).toEqual(expect.arrayContaining(["project.json", "slides/fake.svg"]));
  });

  it("rejects with an explicit error and does not start when the presentation id is unknown", async () => {
    await expect(serve("does-not-exist")).rejects.toThrow();
  });

  it("rejects with an explicit error, never falling back to another port, when the port is already in use", async () => {
    const id = await openFreshPresentation();
    const first = await serve(id);

    await expect(serve(id, { port: first.port })).rejects.toThrow(/連接埠/);
  });

  it("rejects with an explicit error when the presentation has no slides", async () => {
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "empty", canvas: { width: 1280, height: 720 }, slides: [] }),
      ),
      "slides/": new Uint8Array(0),
      "assets/": new Uint8Array(0),
    });
    const emptyPath = path.join(comotDir, "empty.comot");
    await writeFile(emptyPath, zipped);
    const opened = await registry.dispatch<{ id: string }>("open", { path: emptyPath });
    const id = opened.data!.id;

    await expect(serve(id)).rejects.toThrow();
  });

  it("responds with an explicit error, not an empty body, for a slide that does not exist", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/files/slides/999.svg`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it("responds with an explicit error for a request that reaches outside the presentation's virtual path space", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    // The virtual path space is the only path space (ADR-0004): a ".."
    // segment is just a literal name that was never discovered on disk, so
    // this is structurally a 404, not a filesystem escape. The traversal
    // string is percent-encoded so the HTTP client's own URL normalization
    // does not collapse it away before the request is even sent — the
    // server must reject it on its own.
    const traversal = encodeURIComponent("../../../../etc/passwd");
    const response = await fetch(`${server.url}/api/files/${traversal}`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
    expect(body.error).not.toContain("root:");
  });

  it("rejects with an explicit Traditional Chinese error at open time when project.json lacks slides", async () => {
    const message = await openMalformedPresentation(
      JSON.stringify({ formatVersion: 1, name: "壞掉的簡報", canvas: { width: 1280, height: 720 } }),
    );

    expect(message).toMatch(/project\.json/);
    expect(message).toMatch(/slides/);
  });

  it("rejects at open time when slides is present but not an array", async () => {
    const message = await openMalformedPresentation(
      JSON.stringify({
        formatVersion: 1,
        name: "壞掉的簡報",
        canvas: { width: 1280, height: 720 },
        slides: "slides/001.svg",
      }),
    );

    expect(message).toMatch(/project\.json/);
    expect(message).toMatch(/slides/);
  });

  it("rejects at open time when slides contains an invalid entry", async () => {
    const message = await openMalformedPresentation(
      JSON.stringify({
        formatVersion: 1,
        name: "壞掉的簡報",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg", 42],
      }),
    );

    expect(message).toMatch(/project\.json/);
    expect(message).toMatch(/slides/);
  });

  it("never leaks the hidden work directory's path in project.json validation errors", async () => {
    // Echoing back the .comot path the caller supplied is legitimate
    // (ADR-0004) — it's the user's own argument, not the work directory.
    // What must never appear is CO_MOTION_HOME's hidden work directory.
    const message = await openMalformedPresentation(
      JSON.stringify({ formatVersion: 1, name: "壞掉的簡報", canvas: { width: 1280, height: 720 } }),
    );

    expect(message).not.toContain(coMotionHome);
  });

  // The exact ticket #12 scenario: a container whose project.json is only
  // `{"formatVersion":1}` used to pass `open`'s formatVersion-only check
  // and then explode inside `serve` as a raw TypeError on `slides` being
  // undefined. It must now be rejected by `open` itself, with a named
  // cause, and never reach `serve` at all.
  it("rejects {\"formatVersion\":1} at open time, naming the missing field, never reaching serve", async () => {
    const message = await openMalformedPresentation(JSON.stringify({ formatVersion: 1 }));

    expect(message).toMatch(/project\.json/);
    expect(message).toMatch(/name/);
  });
});

describe("static frontend serving", () => {
  // These tests populate the real packages/web/dist directory startServe's
  // resolveWebDist() always resolves to (it takes no override), and always
  // remove it again afterward so the suite leaves no build artifact behind.
  afterEach(async () => {
    await rm(webDist, { recursive: true, force: true });
  });

  it("serves index.html for the root path", async () => {
    await mkdir(webDist, { recursive: true });
    await writeFile(path.join(webDist, "index.html"), "<html><body>root</body></html>");
    const id = await openFreshPresentation();
    const server = await serve(id);

    const response = await fetch(`${server.url}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("root");
  });

  it("serves an existing static asset with its correct content type", async () => {
    await mkdir(webDist, { recursive: true });
    await writeFile(path.join(webDist, "index.html"), "<html></html>");
    await writeFile(path.join(webDist, "app.js"), "console.log('hi');");
    const id = await openFreshPresentation();
    const server = await serve(id);

    const response = await fetch(`${server.url}/app.js`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(body).toBe("console.log('hi');");
  });

  it("responds 404 for a static asset that does not exist, without falling back to index.html", async () => {
    await mkdir(webDist, { recursive: true });
    await writeFile(path.join(webDist, "index.html"), "<html><body>root</body></html>");
    const id = await openFreshPresentation();
    const server = await serve(id);

    const response = await fetch(`${server.url}/missing-bundle.js`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it("responds with the existing explicit error when the frontend has not been built at all", async () => {
    // webDist deliberately left absent by this test.
    const id = await openFreshPresentation();
    const server = await serve(id);

    const response = await fetch(`${server.url}/`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("前端尚未建置，請先執行 build");
  });

  it("responds 500, not a disguised 200, when a static read fails for a reason other than not-found", async () => {
    await mkdir(webDist, { recursive: true });
    await writeFile(path.join(webDist, "index.html"), "<html></html>");
    const restrictedDir = path.join(webDist, "restricted.js");
    // A directory where a file is expected: readFile fails with EISDIR,
    // not ENOENT — the "any other I/O failure" case from the review.
    await mkdir(restrictedDir);
    const id = await openFreshPresentation();
    const server = await serve(id);

    const response = await fetch(`${server.url}/restricted.js`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBeTruthy();
  });
});
