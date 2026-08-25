import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";

// The real build output `resolveWebDist()` defaults to. `npm run test:e2e`
// runs a browser against exactly these bytes, so this suite must never
// write to or delete from here (ticket #20). Referenced only by the
// isolation guard at the bottom of this file, never by a test's fixtures.
const realWebDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

/**
 * Content fingerprint of the real build output: every entry's path and hash,
 * or "<absent>" when the frontend has not been built. Comparing this before
 * and after the suite proves no test touched it, rather than trusting that
 * none of them meant to.
 */
async function fingerprintRealWebDist(): Promise<string> {
  let names: string[];
  try {
    names = await readdir(realWebDist, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "<absent>";
    throw error;
  }
  const lines: string[] = [];
  for (const name of names.sort()) {
    const full = path.join(realWebDist, name);
    let bytes: Buffer;
    try {
      bytes = await readFile(full);
    } catch (error) {
      // Directories read as EISDIR: record the entry anyway, it is still
      // part of the tree's shape.
      if ((error as NodeJS.ErrnoException).code === "EISDIR") {
        lines.push(`${name} <dir>`);
        continue;
      }
      throw error;
    }
    lines.push(`${name} ${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return lines.join("\n");
}

let realWebDistFingerprint: string;

beforeAll(async () => {
  realWebDistFingerprint = await fingerprintRealWebDist();
});

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

// root ignores permission bits, so the chmod(0o000)-based I/O-failure test
// below can never observe a real EACCES there. Same detection ticket #10's
// and #11's tests already established (packages/cli/test/commands.test.ts,
// packages/server/test/raw.test.ts) — reused rather than reinvented.
const isRunningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Seam B: start the real server, drive it over HTTP, never open a browser.
// Every test points CO_MOTION_HOME at its own temp directory (ADR-0004
// testing convention) and always binds port 0, reading the assigned port
// back — a fixed port would collide with ticket #6's own server tests.

let coMotionHome: string;
let comotDir: string;
// Where this test's server serves static files from — a throwaway stand-in
// for packages/web/dist, injected via ServeOptions.staticDir. Deliberately
// NOT created here: the "frontend was never built" test needs it absent,
// and every other static test creates it itself.
let webDist: string;
let staticRoot: string;
let registry: CommandRegistry;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-serve-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-serve-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "co-motion-serve-static-"));
  webDist = path.join(staticRoot, "dist");
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
  await rm(staticRoot, { recursive: true, force: true });
});

async function openFreshPresentation(name = "測試簡報"): Promise<string> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

/**
 * A presentation carrying one binary asset whose bytes are a 0x00..0xff
 * ramp, so a byte range can be asserted by value rather than by length
 * alone. Real fflate zip, real `open`, no mocks.
 */
const RAMP_BYTES = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

async function openPresentationWithRampAsset(): Promise<string> {
  const { zipSync } = await import("fflate");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        name: "有資產的簡報",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode("<svg/>"),
    "assets/clip.mp4": RAMP_BYTES,
  });
  const comotPath = path.join(comotDir, "with-ramp-asset.comot");
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return opened.data!.id;
}

async function serve(presentationId: string, overrides: Partial<Parameters<typeof startServe>[0]> = {}) {
  // staticDir is passed unconditionally, before ...overrides: no test in
  // this file can reach the real packages/web/dist by forgetting to opt out.
  const server = await startServe({
    registry,
    presentationId,
    port: 0,
    agent: fakeAgent,
    staticDir: webDist,
    ...overrides,
  });
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
  // The `/api/raw/` route reads the request's Range header and hands it to
  // handleRawRequest (ticket #13). raw.test.ts calls that function directly,
  // which deliberately proves the range logic without serve.ts — so nothing
  // there would notice if this route stopped passing the header along. These
  // two tests cover exactly that wiring, over a real socket.
  it("/api/raw/ 把請求的 Range 標頭一路帶到位元組切片，回 206 與確切的區間", async () => {
    const id = await openPresentationWithRampAsset();

    const server = await serve(id);
    const response = await fetch(`${server.url}/api/raw/assets/clip.mp4`, {
      headers: { Range: "bytes=10-19" },
    });
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(body.equals(RAMP_BYTES.subarray(10, 20))).toBe(true);
  });

  it("/api/raw/ 沒有 Range 標頭時仍回 200 完整檔案，並宣告 Accept-Ranges", async () => {
    const id = await openPresentationWithRampAsset();

    const server = await serve(id);
    const response = await fetch(`${server.url}/api/raw/assets/clip.mp4`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(body.equals(RAMP_BYTES)).toBe(true);
  });

  it("binds port 0 and reports back the actual assigned port", async () => {
    const id = await openFreshPresentation();

    const server = await serve(id);

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  // ADR-0010 / ticket #28: an opaque-origin document (the play iframe, once
  // it has `allow-scripts`) sends the literal header value "Origin: null"
  // on a cross-origin request. Rejecting it closes the write-blind gap that
  // opening `allow-scripts` creates — the two are one gate, checked ahead
  // of routing so every endpoint gets it, not just the ones written today.
  it("rejects a request carrying Origin: null, on a GET route and on the POST route alike", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    const getResponse = await fetch(`${server.url}/api/presentation`, { headers: { Origin: "null" } });
    expect(getResponse.status).toBe(403);
    const getBody = (await getResponse.json()) as { error: string };
    expect(getBody.error).toMatch(/[一-鿿]/);

    const postResponse = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { Origin: "null", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(postResponse.status).toBe(403);
  });

  // ADR-0011 / #56: view mode's iframe now also carries allow-scripts, so
  // it is opaque-origin too and can send the same "Origin: null" writes
  // ADR-0010 already worried about for play mode. The gate above
  // (`req.headers.origin === "null"`, serve.ts:203) is checked ahead of
  // every route already — this pins that it holds for the specific route
  // view mode's own iframe fetches (`/api/files/<slide>`, canvas.ts's
  // render()), not just the play-mode routes the pre-existing test above
  // already covers.
  it("rejects a request carrying Origin: null on /api/files/*, the route view mode's own iframe fetches", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/files/slides/001.svg`, { headers: { Origin: "null" } });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/[一-鿿]/);
  });

  it("does not reject a normal request with no Origin header, or a same-origin Origin", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    const noOrigin = await fetch(`${server.url}/api/presentation`);
    expect(noOrigin.status).toBe(200);

    const sameOrigin = await fetch(`${server.url}/api/presentation`, { headers: { Origin: server.url } });
    expect(sameOrigin.status).toBe(200);
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

  // Ticket #14: `/api/files/` used to turn every dispatch failure into a
  // 404, so a permission problem, a failing disk or a corrupt registry all
  // told the author "your file is missing" and sent them looking in
  // completely the wrong place. Same classification as `/api/raw/`
  // (ticket #11): only a positively proven absence is a 404.
  it.skipIf(isRunningAsRoot)("responds 500, not 404, when the slide exists but the underlying read fails", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);
    // Real filesystem path of the unpacked slide, per workspace.ts's
    // workDirFor(home, id) = path.join(home, "work", id). Only used to
    // break the read (chmod) — never asserted against the response.
    const realSlidePath = path.join(coMotionHome, "work", id, "slides", "001.svg");
    await chmod(realSlidePath, 0o000);

    try {
      const response = await fetch(`${server.url}/api/files/slides/001.svg`);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBeTruthy();
      // A real I/O failure must never be told back as "the file is missing".
      expect(body.error).not.toBe("找不到檔案：slides/001.svg");
      // The real filesystem path must never leak (ADR-0004, third layer).
      expect(body.error).not.toContain(realSlidePath);
      expect(body.error).not.toContain(coMotionHome);
      expect(body.error).not.toContain("EACCES");
    } finally {
      await chmod(realSlidePath, 0o644);
    }
  });

  it("responds 500, not 404, when the presentation registry itself is corrupt", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);
    // Corrupted for real (malformed JSON on disk, no mocking), per
    // workspace.ts's registryPath(home) = path.join(home, "projects.json").
    // A damaged registry is a server-side failure, not evidence the
    // requested slide is missing.
    await writeFile(path.join(coMotionHome, "projects.json"), "{ not valid json");

    const response = await fetch(`${server.url}/api/files/slides/001.svg`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("簡報登記資料已損毀");
    expect(body.error).not.toContain(coMotionHome);
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
  // These tests populate `webDist`, a fresh temp directory per test that
  // the shared `serve()` helper injects as ServeOptions.staticDir. The
  // outer afterEach removes its whole root — no cleanup of the real build
  // output is needed, because nothing here ever writes there.

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

// Ticket #20: declared last, so it runs after every test above. This is
// what makes "tests never touch the real build output" a checked property
// instead of a convention — point the static tests back at the real
// packages/web/dist and this goes red.
describe("real build output isolation", () => {
  it("leaves packages/web/dist exactly as the suite found it", async () => {
    expect(await fingerprintRealWebDist()).toBe(realWebDistFingerprint);
  });
});
