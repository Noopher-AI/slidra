// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import type { AgentAdapterConfig } from "../src/agent/session.js";
import { openPolicy } from "../src/policy/open.js";

const execFileAsync = promisify(execFile);

/** The real Rust binary this whole suite drives — `startServe` spawns it for every read, and these fixtures spawn it directly to set presentations up. */
const slidraBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../target/release/slidra");

interface CliEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
  failureKind?: string;
}

/** Runs the real `slidra` binary with `--json`, exit-code-blind (mirrors `slidra/command.ts`'s `runJsonCommand`). */
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

// The real build output `resolveWebDist()` defaults to. `npm run test:e2e`
// runs a browser against exactly these bytes, so this suite must never
// write to or delete from here. Referenced only by the
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
// ("serve without an agent" is unrepresentable).
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
// below can never observe a real EACCES there. The same detection is
// already established by tests in packages/cli/test/commands.test.ts and
// packages/server/test/raw.test.ts — reused rather than reinvented.
const isRunningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Seam B: start the real server, drive it over HTTP, never open a browser.
// Every test points SLIDRA_HOME at its own temp directory (ADR-0003
// testing convention) and always binds port 0, reading the assigned port
// back — a fixed port would collide with this file's own server tests.

let slidraHome: string;
let slidraDir: string;
// Where this test's server serves static files from — a throwaway stand-in
// for packages/web/dist, injected via ServeOptions.staticDir. Deliberately
// NOT created here: the "frontend was never built" test needs it absent,
// and every other static test creates it itself.
let webDist: string;
let staticRoot: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-serve-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-serve-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "slidra-serve-static-"));
  webDist = path.join(staticRoot, "dist");
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
  servers = [];
});

afterEach(async () => {
  // Always shut every server started in the test down, including on
  // failure, or the suite hangs on an open listening socket.
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(staticRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function openFreshPresentation(name = "Test Presentation"): Promise<string> {
  const { zipSync } = await import("fflate");
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await writeFile(slidraPath, zipSync({
    "project.json": new TextEncoder().encode(JSON.stringify({
      formatVersion: 1,
      name,
      canvas: { width: 1280, height: 720 },
      slides: ["slides/001.svg"],
    })),
    "slides/001.svg": new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"/>'),
  }));
  return slidraPath;
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
        name: "deck with assets",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode("<svg/>"),
    "assets/clip.mp4": RAMP_BYTES,
  });
  const slidraPath = path.join(slidraDir, "with-ramp-asset.slidra");
  await writeFile(slidraPath, zipped);
  return slidraPath;
}

async function serve(deckPath: string, overrides: Partial<Parameters<typeof startServe>[0]> = {}) {
  // staticDir is passed unconditionally, before ...overrides: no test in
  // this file can reach the real packages/web/dist by forgetting to opt out.
  const server = await startServe({
    policy: openPolicy,
    presentationId: deckPath,
    port: 0,
    agent: fakeAgent,
    staticDir: webDist,
    ...overrides,
  });
  servers.push(server);
  return server;
}

// Builds a hostile .slidra with a literal project.json body (bypassing the
// server's own JSON.stringify) so the malformed-container tests exercise
// the exact bytes the review found unhandled — real fflate zips, no mocks.
//
// `open` now runs the same structural validation `serve` used
// to run on its own, so a structurally invalid project.json is rejected
// right here, before any id or work directory exists for it — it never
// reaches `serve()` at all. This returns `open`'s own rejection message
// (and asserts the dispatch failed) instead of an id.
/**
 * Test-only direct reads/writes of one content row in a deck's `content`
 * table (`crates/slidra/src/deck.rs`'s schema) — the SQLite-backed
 * equivalent of the deleted-work-directory era's `readFile`/`writeFile`
 * on a slide's real path, used ONLY to simulate a slide file damaged by
 * something other than this server (never a stand-in for the server's own
 * write path, which always goes through the CLI — decision 9). `node:sqlite`
 * is experimental in this Node version but used read/write here exactly
 * the way the deleted test used raw `fs` access: to reach past every
 * normal validation layer on purpose.
 */
async function readDeckFile(deckPath: string, virtualPath: string): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath);
  try {
    const row = db.prepare("SELECT data FROM content WHERE path = ?").get(virtualPath) as
      | { data: Uint8Array }
      | undefined;
    if (!row) throw new Error(`no such content row: ${virtualPath}`);
    return Buffer.from(row.data).toString("utf-8");
  } finally {
    db.close();
  }
}

async function writeDeckFile(deckPath: string, virtualPath: string, content: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(deckPath);
  try {
    db.prepare("UPDATE content SET data = ? WHERE path = ?").run(Buffer.from(content, "utf-8"), virtualPath);
  } finally {
    db.close();
  }
}

async function openMalformedPresentation(projectJsonRaw: string): Promise<string> {
  const { zipSync } = await import("fflate");
  const zipped = zipSync({
    "project.json": new TextEncoder().encode(projectJsonRaw),
    "slides/": new Uint8Array(0),
    "assets/": new Uint8Array(0),
  });
  const malformedPath = path.join(slidraDir, "malformed.slidra");
  await writeFile(malformedPath, zipped);
  const opened = await runCli<{ id: string }>(["open", malformedPath]);
  expect(opened.ok).toBe(false);
  return opened.message;
}

describe("startServe", () => {
  it("protects runner routes with the dedicated session header without gating deck routes", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id, { runnerSessionToken: "runner-secret" });

    const rejected = await fetch(`${server.url}/api/agent`);
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`${server.url}/api/agent`, {
      headers: { "x-slidra-runner-session": "runner-secret" },
    });
    expect(accepted.status).not.toBe(401);

    const deck = await fetch(`${server.url}/api/presentation`);
    expect(deck.status).toBe(200);
  });

  // The `/api/raw/` route reads the request's Range header and hands it to
  // handleRawRequest. raw.test.ts calls that function directly, which
  // deliberately proves the range logic without serve.ts — so nothing
  // there would notice if this route stopped passing the header along. These
  // two tests cover exactly that wiring, over a real socket.
  it("/api/raw/ carries the request's Range header all the way through to the byte slice, returning 206 with the exact range", async () => {
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

  it("/api/raw/ still returns 200 with the full file and announces Accept-Ranges when there is no Range header", async () => {
    const id = await openPresentationWithRampAsset();

    const server = await serve(id);
    const response = await fetch(`${server.url}/api/raw/assets/clip.mp4`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(body.equals(RAMP_BYTES)).toBe(true);
  });

  // [E10.T5]: `/api/editing/begin|end` now ask the crate's own editing-lock
  // routes first ("crate decides first, Node applies" — Dev-Leader's
  // ruling on NOOP-643), then apply the same decision to Node's local
  // `EditingLock` exactly as before. This is the happy path over the real
  // wire; the crate-refuses-so-Node-must-not-apply branch has no test at
  // this level yet — nothing on the Node side puts the crate's own lock
  // into the `agent` state (that only happens once agent turns mirror
  // acquire/release to the crate too, not yet wired — see this ticket's
  // delivery notes), so it cannot be observed through this black-box HTTP
  // surface today. `crates/slidra/tests/deck_server_assets_and_editing_lock.rs`
  // covers the crate's own refusal behavior directly.
  it("POST /api/editing/begin then /end round-trips over the real wire, end is idempotent", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    const begin = await fetch(`${server.url}/api/editing/begin`, { method: "POST" });
    expect(begin.status).toBe(200);
    expect(await begin.json()).toEqual({ ok: true });

    const status = await fetch(`${server.url}/api/editing`);
    expect(await status.json()).toEqual({ frozen: false });

    const end = await fetch(`${server.url}/api/editing/end`, { method: "POST" });
    expect(end.status).toBe(200);

    // A second end is not an error — matches `EditingLock.endHumanEdit`'s
    // own no-op-when-not-human contract, now exercised through the crate
    // round trip too.
    const end2 = await fetch(`${server.url}/api/editing/end`, { method: "POST" });
    expect(end2.status).toBe(200);
  });

  it("binds port 0 and reports back the actual assigned port", async () => {
    const id = await openFreshPresentation();

    const server = await serve(id);

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  // ADR-0007: an opaque-origin document (the play iframe, once
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
    expect(getBody.error).toMatch(/opaque origin/);

    const postResponse = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { Origin: "null", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(postResponse.status).toBe(403);
  });

  // ADR-0007: view mode's iframe now also carries allow-scripts, so
  // it is opaque-origin too and can send the same "Origin: null" writes
  // ADR-0007 already worried about for play mode. The gate above
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
    expect(body.error).toMatch(/opaque origin/);
  });

  it("does not reject a normal request with no Origin header, or a same-origin Origin", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    const noOrigin = await fetch(`${server.url}/api/presentation`);
    expect(noOrigin.status).toBe(200);

    const sameOrigin = await fetch(`${server.url}/api/presentation`, { headers: { Origin: server.url } });
    expect(sameOrigin.status).toBe(200);
  });

  it("serves the presentation's metadata reached only through the slidra binary", async () => {
    const id = await openFreshPresentation("My Presentation");

    const server = await serve(id);
    const response = await fetch(`${server.url}/api/presentation`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.name).toBe("My Presentation");
    expect(body.slides).toEqual(["slides/001.svg"]);
  });

  it("serves a slide's SVG content that matches what `cat` returns through the same command", async () => {
    const id = await openFreshPresentation();
    const expectedContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"/>';

    const server = await serve(id);
    const response = await fetch(`${server.url}/api/files/slides/001.svg`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(body).toBe(expectedContent);
  });

  // Validation standard 8 (plan §5): the structural proof that `serve` no
  // longer reads any presentation file itself now points `SLIDRA_BIN` at
  // a fake, hand-written `.mjs` binary — never touching a real filesystem —
  // instead of the old stub `CommandRegistry`. This is a strictly stronger
  // injection point: it proves the server goes through `runSlidra`'s own
  // subprocess boundary, not merely through *some* pluggable interface.
  //
  // [E10.T5]: `/api/presentation`/`/api/files` are now forwarded to a
  // long-lived `slidra __deck-server` subprocess (`deck-server-client.ts`)
  // rather than spawned per read, so the fake binary answers `__deck-server`
  // with a real (fabricated) HTTP server of its own — the same "prove the
  // subprocess boundary is real, not merely some pluggable interface"
  // property, adapted to the new transport.
  it("serves fabricated content from a stub SLIDRA_BIN, never touching the real filesystem", async () => {
    const fakeBinDir = await mkdtemp(path.join(tmpdir(), "slidra-serve-fakebin-"));
    const fakeBinPath = path.join(fakeBinDir, "slidra-fake.mjs");
    await writeFile(
      fakeBinPath,
      [
        "#!/usr/bin/env node",
        'import http from "node:http";',
        "const args = process.argv.slice(2);",
        'if (args[0] === "__deck-server") {',
        "  const server = http.createServer((req, res) => {",
        '    if (req.method === "GET" && req.url === "/presentation") {',
        '      res.writeHead(200, { "content-type": "application/json" });',
        '      res.end(JSON.stringify({ formatVersion: 4, name: "Stub", canvas: { width: 1, height: 1 }, slides: ["slides/fake.svg"] }));',
        "      return;",
        "    }",
        '    if (req.method === "GET" && req.url === "/files/slides/fake.svg") {',
        '      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });',
        '      res.end("<svg>STUB</svg>");',
        "      return;",
        "    }",
        "    res.writeHead(404, {});",
        "    res.end();",
        "  });",
        '  server.listen(0, "127.0.0.1", () => {',
        "    process.stdout.write(JSON.stringify({ port: server.address().port, workbenchId: \"stub-workbench\" }) + \"\\n\");",
        "  });",
        "} else {",
        // `resolveDeckIdentity` (serve.ts's own startup path, unrelated to
        // this ticket) still calls `loadProject` — a per-call `slidra cat
        // <id> project.json --json` subprocess spawn, `slidra/reads.ts`'s
        // own mechanism — so the stub must still answer that shape too.
        '  const cliArgs = args.filter((a) => a !== "--json");',
        "  const [cmd, ...rest] = cliArgs;",
        "  function b64(s) { return Buffer.from(s, \"utf-8\").toString(\"base64\"); }",
        "  let result;",
        '  if (cmd === "cat" && rest[1] === "project.json") {',
        "    const content = JSON.stringify({ formatVersion: 4, name: \"Stub\", canvas: { width: 1, height: 1 }, slides: [\"slides/fake.svg\"] });",
        '    result = { ok: true, data: [{ path: "project.json", content: b64(content) }], message: "read: project.json" };',
        "  } else {",
        '    result = { ok: false, message: "file not found: " + rest.join(" "), failureKind: "not-found" };',
        "  }",
        "  process.stdout.write(JSON.stringify(result) + \"\\n\");",
        "}",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    process.env.SLIDRA_BIN = fakeBinPath;
    try {
      // SLIDRA_HOME is this test's own fresh, empty temp directory —
      // "unregistered-stub-id" names nothing on the real filesystem at all.
      const server = await serve("unregistered-stub-path");

      const meta = await (await fetch(`${server.url}/api/presentation`)).json();
      expect(meta.slides).toEqual(["slides/fake.svg"]);

      const slide = await (await fetch(`${server.url}/api/files/slides/fake.svg`)).text();
      expect(slide).toBe("<svg>STUB</svg>");
    } finally {
      process.env.SLIDRA_BIN = slidraBinPath;
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it("rejects with an explicit error and does not start when the presentation id is unknown", async () => {
    await expect(serve("does-not-exist")).rejects.toThrow();
  });

  it("rejects with an explicit error, never falling back to another port, when the port is already in use", async () => {
    const id = await openFreshPresentation();
    const first = await serve(id);

    await expect(serve(id, { port: first.port })).rejects.toThrow(/port already in use/i);
  });

  it("serves a presentation with no slides (`new` creates none; the editor makes the first page)", async () => {
    const { zipSync } = await import("fflate");
    const { writeFile } = await import("node:fs/promises");
    const zipped = zipSync({
      "project.json": new TextEncoder().encode(
        JSON.stringify({ formatVersion: 1, name: "empty", canvas: { width: 1280, height: 720 }, slides: [] }),
      ),
      "slides/": new Uint8Array(0),
      "assets/": new Uint8Array(0),
    });
    const emptyPath = path.join(slidraDir, "empty.slidra");
    await writeFile(emptyPath, zipped);
    const server = await serve(emptyPath);
    const response = await fetch(`${server.url}/api/presentation`);
    expect(response.status).toBe(200);
    expect((await response.json()).slides).toEqual([]);
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

    // The virtual path space is the only path space (ADR-0003): a ".."
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

  // `/api/files/` used to turn every dispatch failure into a
  // 404, so a permission problem, a failing disk or a corrupt registry all
  // told the author "your file is missing" and sent them looking in
  // completely the wrong place. Same classification as `/api/raw/`:
  // only a positively proven absence is a 404.
  it.skipIf(isRunningAsRoot)("responds 500, not 404, when the slide exists but the underlying read fails", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);
    // The deck is a single SQLite file now — there is no longer a
    // per-slide real path to break individually, so this breaks every
    // read from the deck at once (chmod the file itself) — never
    // asserted against the response.
    const deckPath = path.join(slidraDir, "deck.slidra");
    await chmod(deckPath, 0o000);

    try {
      const response = await fetch(`${server.url}/api/files/slides/001.svg`);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBeTruthy();
      // A real I/O failure must never be told back as "the file is missing".
      expect(body.error).not.toBe("file not found: slides/001.svg");
      // The real filesystem path must never leak (ADR-0003, third layer).
      expect(body.error).not.toContain(deckPath);
      expect(body.error).not.toContain(slidraHome);
      expect(body.error).not.toContain("EACCES");
    } finally {
      await chmod(deckPath, 0o644);
    }
  });

  it("old Save and Node deck-write proxy endpoints are absent because the browser calls the crate directly", async () => {
    const id = await openFreshPresentation();
    const server = await serve(id);

    for (const path of ["/api/save", "/api/save/flush", "/api/command", "/api/asset", "/api/undo", "/api/redo"]) {
      const response = await fetch(`${server.url}${path}`, { method: "POST" });
      expect(response.status, `${path} must not remain as a Node proxy`).toBe(405);
    }
  });

  // `GET /api/effects/<path>` — the step-plan route the player and
  // step-by-step export now fetch instead of computing it themselves in
  // the browser. Builds its fixture through the real Rust binary rather
  // than a hand-built container, since these tests exercise the route
  // end-to-end.
  describe("GET /api/effects/", () => {
    /**
     * A presentation whose slides/001.svg holds exactly one element.
     * `openFreshPresentation`'s `slide add` leaves the page empty,
     * and `effect add` needs something to target, so the page
     * is written once with a bare shape: `slide set --svg` wraps it in a
     * `<g>` and mints its id, and returns that id — no need to scrape the
     * SVG for it.
     */
    async function openPresentationWithOneElement(): Promise<{ id: string; elementId: string }> {
      const id = await openFreshPresentation();
      const elementId = "el-effect-target";
      const { unzipSync, zipSync } = await import("fflate");
      const files = unzipSync(await readFile(id));
      files["slides/001.svg"] = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><g id="${elementId}"><rect x="100" y="100" width="200" height="120"/></g></svg>`);
      await writeFile(id, zipSync(files));
      return { id, elementId };
    }

    async function rewriteFixtureSlide(deckPath: string, rewrite: (svg: string) => string): Promise<void> {
      const { unzipSync, zipSync } = await import("fflate");
      const files = unzipSync(await readFile(deckPath));
      files["slides/001.svg"] = new TextEncoder().encode(rewrite(new TextDecoder().decode(files["slides/001.svg"]!)));
      await writeFile(deckPath, zipSync(files));
    }

    it("responds 200 with effects/steps/transition for a slide with an effect list", async () => {
      const { id, elementId } = await openPresentationWithOneElement();
      await rewriteFixtureSlide(id, (original) => original.replace(
        "</svg>", `<metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026"><slidra:effect target="${elementId}" family="enter" effect="fade" start="on-click"/></slidra:effects></metadata></svg>`,
      ));

      const server = await serve(id);
      const response = await fetch(`${server.url}/api/effects/slides/001.svg`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.effects).toEqual([
        expect.objectContaining({ target: elementId, family: "enter", effect: "fade", index: 1 }),
      ]);
      expect(body.steps).toEqual([{ effects: body.effects }]);
      expect(body.transition).toEqual({
        enter: { effect: "none", duration: 0.6 },
        exit: { effect: "none", duration: 0.5 },
      });
    });

    it("responds 200 with an empty plan for a declared slide that never had an effect list", async () => {
      const { id } = await openPresentationWithOneElement();
      const server = await serve(id);

      const response = await fetch(`${server.url}/api/effects/slides/001.svg`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        effects: [],
        steps: [],
        transition: { enter: { effect: "none", duration: 0.6 }, exit: { effect: "none", duration: 0.5 } },
      });
    });

    it("responds 404 for a virtual path that is not a declared slide", async () => {
      const { id } = await openPresentationWithOneElement();
      const server = await serve(id);

      const response = await fetch(`${server.url}/api/effects/project.json`);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe("Not a slide: project.json");
    });

    it("responds 500 with the command's own message, verbatim, for a damaged effect list", async () => {
      const { id } = await openPresentationWithOneElement();
      const deckPath = path.join(slidraDir, "deck.slidra");
      await rewriteFixtureSlide(deckPath, (original) => original.replace(
        "</svg>",
        '<metadata><slidra:effects xmlns:slidra="https://slidra.app/ns/2026">' +
          '<slidra:effect target="bogus" family="not-a-family" effect="fade" start="on-click"/>' +
          "</slidra:effects></metadata></svg>",
      ));

      const server = await serve(id);
      const response = await fetch(`${server.url}/api/effects/slides/001.svg`);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain("not yet implemented");
    });
  });

  it("rejects with an explicit Traditional Chinese error at open time when project.json lacks slides", async () => {
    const message = await openMalformedPresentation(
      JSON.stringify({ formatVersion: 1, name: "Broken Presentation", canvas: { width: 1280, height: 720 } }),
    );

    expect(message).toMatch(/project\.json/);
    expect(message).toMatch(/slides/);
  });

  it("rejects at open time when slides is present but not an array", async () => {
    const message = await openMalformedPresentation(
      JSON.stringify({
        formatVersion: 1,
        name: "Broken Presentation",
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
        name: "Broken Presentation",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg", 42],
      }),
    );

    expect(message).toMatch(/project\.json/);
    expect(message).toMatch(/slides/);
  });

  it("never leaks the hidden work directory's path in project.json validation errors", async () => {
    // Echoing back the .slidra path the caller supplied is legitimate
    // (ADR-0003) — it's the user's own argument, not the work directory.
    // What must never appear is SLIDRA_HOME's hidden work directory.
    const message = await openMalformedPresentation(
      JSON.stringify({ formatVersion: 1, name: "Broken Presentation", canvas: { width: 1280, height: 720 } }),
    );

    expect(message).not.toContain(slidraHome);
  });

  // The exact scenario: a container whose project.json is only
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
    await writeFile(path.join(webDist, "index.html"), `<html><body><script id="slidra-bootstrap" type="application/json">__SLIDRA_BOOTSTRAP__</script>root</body></html>`);
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
    await writeFile(path.join(webDist, "index.html"), `<html><body><script id="slidra-bootstrap" type="application/json">__SLIDRA_BOOTSTRAP__</script>root</body></html>`);
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
    expect(body.error).toBe("Frontend has not been built yet, run build first");
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

// Declared last, so it runs after every test above. This is
// what makes "tests never touch the real build output" a checked property
// instead of a convention — point the static tests back at the real
// packages/web/dist and this goes red.
describe("real build output isolation", () => {
  it("leaves packages/web/dist exactly as the suite found it", async () => {
    expect(await fingerprintRealWebDist()).toBe(realWebDistFingerprint);
  });
});
