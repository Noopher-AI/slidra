import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, CommandRegistry } from "@co-motion/cli";
import { startServe } from "../src/serve.js";
import type { RunningServer } from "../src/serve.js";
import { rawContentTypeFor } from "../src/raw.js";

// Ticket #11: agents read text through `cat` (strict UTF-8, rejects
// binary); browsers need the byte-preserving `/api/raw/` route instead.
// These tests hit the real HTTP server (Seam B), never CO_MOTION_HOME's
// real path, and always bind port 0.

// root ignores permission bits, so the chmod(0o000)-based I/O-failure test
// below can never observe a real EACCES there. Same detection ticket #10's
// tests already established (packages/cli/test/commands.test.ts,
// packages/core/test/workspace.test.ts) — reused rather than reinvented.
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

let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-raw-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-raw-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
});

async function serve(presentationId: string): Promise<RunningServer> {
  const server = await startServe({ registry, presentationId, port: 0 });
  servers.push(server);
  return server;
}

/**
 * Builds a real `.comot` zip (fflate, no mocks) containing a real slide
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
  });
  const comotPath = path.join(comotDir, "with-assets.comot");
  await writeFile(comotPath, zipped);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
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
      const realAssetPath = path.join(coMotionHome, "work", id, "assets", "photo.png");
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
        expect(body.error).not.toContain(coMotionHome);
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
      const realAssetsDir = path.join(coMotionHome, "work", id, "assets");
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
        expect(body.error).not.toContain(coMotionHome);
      } finally {
        await chmod(realAssetsDir, 0o755);
      }
    },
  );

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

describe("`co-motion cat` on a binary file — unchanged by ticket #11", () => {
  it("still refuses a binary asset with the existing error message", async () => {
    const id = await openPresentationWithAssets();

    const result = await registry.dispatch<{ content: string }>("cat", { id, path: "assets/photo.png" });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("assets/photo.png 是二進位資產，無法以文字讀取");
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
});
