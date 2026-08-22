import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";

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
  const server = await startServe({ registry, presentationId, port: 0, ...overrides });
  servers.push(server);
  return server;
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
});
