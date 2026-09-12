import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleRawRequest, rawContentTypeFor } from "../src/raw.js";

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

// Agents read text through `cat` (strict UTF-8, rejects binary); browsers
// need the byte-preserving `/api/raw/` route instead. These tests hit the
// real HTTP server (Seam B), never SLIDRA_HOME's real path, and always
// bind port 0.

// root ignores permission bits, so the chmod(0o000)-based I/O-failure test
// below can never observe a real EACCES there. The same detection is
// already established by tests in packages/cli/test/commands.test.ts and
// packages/core/test/workspace.test.ts — reused rather than reinvented.
const isRunningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// A hand-constructed minimal PNG: real PNG magic bytes followed by a few
// arbitrary high bytes. It is never decoded as an image by these tests —
// only compared byte-for-byte — but 0x89 as a lone leading byte is
// structurally invalid UTF-8 (a UTF-8 leading byte can never start with
// the bits 10), which is exactly what makes the "cat still refuses it"
// assertion meaningful without mocking anything.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xd8, 0xfe,
]);

// A 256-byte ramp (0x00..0xff): every byte differs from every other, so a
// sliced range can be asserted byte-for-byte and an off-by-one offset can
// never accidentally look correct.
const PATTERN_BYTES = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

let slidraHome: string;
let slidraDir: string;
let servers: RunningServer[];
let rawServers: Server[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-raw-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-raw-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  process.env.SLIDRA_BIN = slidraBinPath;
  servers = [];
  rawServers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(
    rawServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function serve(presentationId: string): Promise<RunningServer> {
  const server = await startServe({ presentationId, port: 0 });
  servers.push(server);
  return server;
}

/**
 * Builds a real `.slidra` zip (fflate, no mocks) containing a real slide
 * SVG plus a genuinely binary asset and a non-ASCII-named asset, and opens
 * it through the real `open` command. Mirrors serve.test.ts's
 * `openMalformedPresentation` technique.
 */
async function openPresentationWithAssets(): Promise<string> {
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
    "slides/001.svg": new TextEncoder().encode('<svg><image href="../assets/photo.png"/></svg>'),
    "assets/photo.png": PNG_BYTES,
    "assets/照片.png": PNG_BYTES,
    "assets/notes.txt": new TextEncoder().encode("純文字資產"),
    "assets/data.bin": PNG_BYTES,
    "assets/clip.mp4": PATTERN_BYTES,
    "assets/empty.mp4": new Uint8Array(0),
  });
  const slidraPath = path.join(slidraDir, "with-assets.slidra");
  await writeFile(slidraPath, zipped);
  const opened = await runCli<{ id: string }>(["open", slidraPath]);
  expect(opened.ok).toBe(true);
  return opened.data!.id;
}

describe("GET /api/raw/<virtual path>", () => {
  it("returns the exact bytes of a binary asset with the correct Content-Type and Content-Length", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets/photo.png`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG_BYTES.length));
    expect(body.equals(PNG_BYTES)).toBe(true);
  });

  it("sends Cache-Control: no-store, since the same virtual path can serve different bytes over time", async () => {
    // The canvas rebuilds the iframe with the same /api/raw/ URLs on every
    // reload, and without this header the browser may keep serving old
    // bytes from cache after the underlying
    // file changes — despite live reload having fired correctly. No
    // response here carries an ETag/Last-Modified either, so there is
    // nothing for the browser to revalidate against; caching would be
    // unconditionally wrong, not merely stale-prone.
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets/photo.png`);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("resolves a percent-encoded non-ASCII filename to the correct asset", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets/${encodeURIComponent("照片.png")}`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(body.equals(PNG_BYTES)).toBe(true);
  });

  it("serves an unknown extension as application/octet-stream", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets/data.bin`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("makes no text/binary distinction — a UTF-8 text asset is also served as 200", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets/notes.txt`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe("純文字資產");
  });

  it.skipIf(isRunningAsRoot)(
    "returns 500 with an explicit body, not a 404, when the file exists but the underlying read fails",
    async () => {
      const id = await openPresentationWithAssets();
      const server = await serve(id);
      // Real filesystem path of the unpacked asset, per workspace.ts's
      // workDirFor(home, id) = path.join(home, "work", id). Only used to
      // break the read (chmod) — never asserted against the response.
      const realAssetPath = path.join(slidraHome, "work", id, "assets", "photo.png");
      await chmod(realAssetPath, 0o000);

      try {
        const response = await fetch(`${server.url}/api/raw/assets/photo.png`);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBeTruthy();
        // A real I/O failure must never be told back to the browser as
        // "the file is missing".
        expect(body.error).not.toBe("找不到檔案：assets/photo.png");
        // The real filesystem path must never leak into the response.
        expect(body.error).not.toContain(realAssetPath);
        expect(body.error).not.toContain(slidraHome);
      } finally {
        await chmod(realAssetPath, 0o644);
      }
    },
  );

  it.skipIf(isRunningAsRoot)(
    "returns 500, not 404, when a directory earlier in the lookup path is unreadable",
    async () => {
      const id = await openPresentationWithAssets();
      const server = await serve(id);
      // Real filesystem path of the unpacked "assets" directory itself
      // (not a file inside it). Every virtual-path lookup enumerates this
      // directory while building the tree (buildVirtualTree -> populate,
      // packages/core/src/virtual-fs.ts), before ever reaching a file's
      // own read — so an unreadable directory must be a 500 too, not just
      // an unreadable file.
      const realAssetsDir = path.join(slidraHome, "work", id, "assets");
      await chmod(realAssetsDir, 0o000);

      try {
        const response = await fetch(`${server.url}/api/raw/assets/photo.png`);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBeTruthy();
        // A real I/O failure must never be told back to the browser as
        // "the file is missing".
        expect(body.error).not.toBe("找不到檔案：assets/photo.png");
        // The real filesystem path must never leak into the response.
        expect(body.error).not.toContain(realAssetsDir);
        expect(body.error).not.toContain(slidraHome);
      } finally {
        await chmod(realAssetsDir, 0o755);
      }
    },
  );

  it("returns 500, not 404, when the presentation registry itself is corrupt", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);
    // Real filesystem path of projects.json, per workspace.ts's
    // registryPath(home) = path.join(home, "projects.json"). Corrupted for
    // real (malformed JSON on disk, no mocking) — never asserted against
    // the response. A damaged registry is a server-side failure, not
    // evidence the requested asset is missing, so it must not be told
    // back to the author as "your asset is missing".
    const registryPath = path.join(slidraHome, "projects.json");
    await writeFile(registryPath, "{ not valid json");

    const response = await fetch(`${server.url}/api/raw/assets/photo.png`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBeTruthy();
    expect(body.error).not.toBe("找不到檔案：assets/photo.png");
    expect(body.error).not.toContain(registryPath);
    expect(body.error).not.toContain(slidraHome);
  });

  it("404s with an explicit body when the path does not resolve to anything", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets/missing.png`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it("404s, via the structural virtual-path lookup, when the path contains '..' segments", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const traversal = encodeURIComponent("../../../../etc/passwd");
    const response = await fetch(`${server.url}/api/raw/${traversal}`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
    expect(body.error).not.toContain("root:");
  });

  it("404s, never returning the root directory listing, for an empty path", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it("404s when the path resolves to a directory rather than a file", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it("fails explicitly, not with a crash or a 500, on malformed percent-encoding", async () => {
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/raw/assets/%`);

    expect(response.status).toBeLessThan(500);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });
});

describe("text reads (`GET /api/files/`) on a binary file — unchanged", () => {
  it("still refuses a binary asset with the existing error message", async () => {
    // This used to dispatch "cat" against the in-process registry
    // directly — server no longer does that at all, so the same
    // assertion now goes through the one HTTP boundary that still performs
    // this exact strict-UTF-8 rejection (`slidra/reads.ts`'s
    // `readPresentationText`, reached here because "assets/photo.png" is
    // not a declared slide).
    const id = await openPresentationWithAssets();
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/files/assets/photo.png`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("assets/photo.png 是二進位資產，無法以文字讀取");
  });
});

describe("rawContentTypeFor", () => {
  it("derives a Content-Type from the extension only, defaulting to octet-stream", () => {
    expect(rawContentTypeFor("assets/a.png")).toBe("image/png");
    expect(rawContentTypeFor("assets/a.jpg")).toBe("image/jpeg");
    expect(rawContentTypeFor("assets/a.jpeg")).toBe("image/jpeg");
    expect(rawContentTypeFor("assets/a.gif")).toBe("image/gif");
    expect(rawContentTypeFor("assets/a.webp")).toBe("image/webp");
    expect(rawContentTypeFor("assets/a.svg")).toBe("image/svg+xml");
    expect(rawContentTypeFor("assets/a.mp4")).toBe("video/mp4");
    expect(rawContentTypeFor("assets/a.webm")).toBe("video/webm");
    expect(rawContentTypeFor("assets/a.mp3")).toBe("audio/mpeg");
    expect(rawContentTypeFor("assets/a.wav")).toBe("audio/wav");
    expect(rawContentTypeFor("assets/a.json")).toBe("application/json");
    expect(rawContentTypeFor("assets/a.unknownext")).toBe("application/octet-stream");
    expect(rawContentTypeFor("assets/no-extension")).toBe("application/octet-stream");
  });

  // These extensions are the player's own media-effect allow-list
  // (packages/web/src/player-plan.ts's VIDEO_EXTENSIONS/AUDIO_EXTENSIONS) —
  // they must resolve to a real Content-Type here, or the player accepts a
  // file the server serves as application/octet-stream, which some
  // browsers refuse to decode as media (the exact "green on one machine,
  // red on another" failure this guards against for .mp4/Safari).
  // packages/web/test/player-plan.test.ts
  // asserts this from the other direction, reading both allow-lists live.
  it("derives a Content-Type for every extension the player's media allow-list accepts", () => {
    expect(rawContentTypeFor("assets/a.m4v")).toBe("video/mp4");
    expect(rawContentTypeFor("assets/a.mov")).toBe("video/quicktime");
    expect(rawContentTypeFor("assets/a.ogv")).toBe("video/ogg");
    expect(rawContentTypeFor("assets/a.m4a")).toBe("audio/mp4");
    expect(rawContentTypeFor("assets/a.opus")).toBe("audio/ogg");
    expect(rawContentTypeFor("assets/a.oga")).toBe("audio/ogg");
    expect(rawContentTypeFor("assets/a.aac")).toBe("audio/aac");
  });

  it("still does no content sniffing — an unknown extension outside the player's allow-list stays application/octet-stream", () => {
    // Same posture as the very first test in this block, re-asserted here
    // so this addition cannot be read as having loosened it: an
    // unknown extension is still never guessed from bytes.
    expect(rawContentTypeFor("assets/a.ogg")).toBe("application/octet-stream");
  });
});

/**
 * A real HTTP server whose only route is `handleRawRequest` — the same
 * shape serve.ts's `/api/raw/` branch has, minus everything else serve.ts
 * does. Range tests need the request's `Range` header to reach
 * `handleRawRequest`, and serve.ts's call site does not pass it yet, so
 * these tests drive the handler directly over
 * real HTTP rather than editing serve.ts. Nothing is mocked: real sockets,
 * real presentation, real bytes on disk.
 */
async function serveRawDirectly(presentationId: string): Promise<string> {
  const server = createServer((req, res) => {
    let virtualPath: string;
    try {
      virtualPath = decodeURIComponent(new URL(req.url!, "http://127.0.0.1").pathname.slice(1));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "路徑編碼無效" }));
      return;
    }
    void handleRawRequest(presentationId, virtualPath, res, req.headers.range);
  });
  rawServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fetchRaw(baseUrl: string, virtualPath: string, range?: string): Promise<Response> {
  return fetch(`${baseUrl}/${virtualPath}`, range === undefined ? undefined : { headers: { Range: range } });
}

describe("GET /api/raw/<virtual path> HTTP Range support", () => {
  it("returns 200 with the full file and Accept-Ranges: bytes when there is no Range header", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("256");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBeNull();
    expect(body.equals(PATTERN_BYTES)).toBe(true);
  });

  it("an explicit range bytes=0-9 returns 206 with exactly 10 bytes", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "bytes=0-9");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-9/256");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(body.equals(PATTERN_BYTES.subarray(0, 10))).toBe(true);
  });

  it("an open-ended range bytes=100- returns 206 from byte 100 to the end of file", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "bytes=100-");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-255/256");
    expect(response.headers.get("content-length")).toBe("156");
    expect(body.equals(PATTERN_BYTES.subarray(100))).toBe(true);
  });

  it("a suffix range bytes=-50 returns 206 with the last 50 bytes", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "bytes=-50");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 206-255/256");
    expect(response.headers.get("content-length")).toBe("50");
    expect(body.equals(PATTERN_BYTES.subarray(206))).toBe(true);
  });

  it("an end past the end of file, bytes=0-999999, is clamped to the end of file and is still 206", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "bytes=0-999999");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-255/256");
    expect(response.headers.get("content-length")).toBe("256");
    expect(body.equals(PATTERN_BYTES)).toBe(true);
  });

  it("a multi-range request is explicitly rejected as 416, not silently answered with just the first range", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "bytes=0-9,20-29");
    const body = await response.json();

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */256");
    expect(body.error).toContain("多重區間");
  });

  it("a range that falls entirely past the end of file returns 416, not the whole file", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "bytes=300-400");
    const body = await response.json();

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */256");
    expect(body.error).toBeTruthy();
  });

  it("an empty file returns 416 for any range, with Content-Range: bytes */0", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/empty.mp4", "bytes=0-9");
    const body = await response.json();

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */0");
    expect(body.error).toBeTruthy();
  });

  it("a syntactically invalid Range is ignored per RFC, returning 200 with the full file", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "bytes=abc");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(body.equals(PATTERN_BYTES)).toBe(true);
  });

  it("a non-bytes unit is treated as not understood, returning 200 with the full file", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/clip.mp4", "items=0-9");
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(body.equals(PATTERN_BYTES)).toBe(true);
  });

  it("with a Range request, error classification is unchanged: a missing path is still 404", async () => {
    const id = await openPresentationWithAssets();
    const baseUrl = await serveRawDirectly(id);

    const response = await fetchRaw(baseUrl, "assets/missing.mp4", "bytes=0-9");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBeTruthy();
  });
});
