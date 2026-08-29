import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

let coMotionHome: string;
let comotDir: string;
let sourceDir: string;
let registry: CommandRegistry;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  sourceDir = await mkdtemp(path.join(tmpdir(), "co-motion-sources-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
  await rm(comotDir, { recursive: true, force: true });
  await rm(sourceDir, { recursive: true, force: true });
});

async function openFreshPresentation(): Promise<{ id: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  return { id: opened.data!.id };
}

/** Reads a presentation's real on-disk bytes for a virtual path — only used to prove undo/redo round-trips a *binary* asset's exact bytes, which `cat` cannot do (it strictly decodes UTF-8 and rejects binary content). */
async function readRealAssetBytes(id: string, virtualPath: string): Promise<Buffer> {
  const { readFile: rf } = await import("node:fs/promises");
  const registryRaw = await rf(path.join(coMotionHome, "projects.json"), "utf-8");
  const workDir = (JSON.parse(registryRaw) as Record<string, { workDir: string }>)[id].workDir;
  return rf(path.join(workDir, ...virtualPath.split("/")));
}

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("asset import — local source", () => {
  it("copies a real PNG into assets/ and returns its virtual path and MIME type", async () => {
    const { id } = await openFreshPresentation();
    const sourcePath = path.join(sourceDir, "photo.png");
    await writeFile(sourcePath, PNG_BYTES);

    const result = await registry.dispatch<{ path: string; mimeType: string; kind: string }>("asset import", {
      id,
      source: sourcePath,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ path: "assets/photo.png", mimeType: "image/png", kind: "image" });

    const listed = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "assets" });
    expect(listed.data!.entries).toEqual(["photo.png"]);
  });

  it("rejects a non-media file disguised with a media extension, and writes nothing to assets/", async () => {
    const { id } = await openFreshPresentation();
    const sourcePath = path.join(sourceDir, "fake.png");
    await writeFile(sourcePath, "this is just a text file, not a real image", "utf-8");

    const result = await registry.dispatch("asset import", { id, source: sourcePath });

    expect(result.ok).toBe(false);
    const listed = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "assets" });
    expect(listed.data!.entries).toEqual([]);
  });

  it("fails with a clear error when the source file does not exist", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("asset import", {
      id,
      source: path.join(sourceDir, "missing.png"),
    });

    expect(result.ok).toBe(false);
  });

  it("resolves a conflict-free filename with a -1 suffix when the destination name is already taken", async () => {
    const { id } = await openFreshPresentation();
    const sourcePath = path.join(sourceDir, "photo.png");
    await writeFile(sourcePath, PNG_BYTES);

    const first = await registry.dispatch<{ path: string }>("asset import", { id, source: sourcePath });
    const second = await registry.dispatch<{ path: string }>("asset import", { id, source: sourcePath });

    expect(first.data!.path).toBe("assets/photo.png");
    expect(second.data!.path).toBe("assets/photo-1.png");
    const listed = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "assets" });
    expect(listed.data!.entries.sort()).toEqual(["photo-1.png", "photo.png"]);
  });
});

describe("asset import — undo/redo", () => {
  it("undo removes the imported file; redo brings it back", async () => {
    const { id } = await openFreshPresentation();
    const sourcePath = path.join(sourceDir, "photo.png");
    await writeFile(sourcePath, PNG_BYTES);

    await registry.dispatch("asset import", { id, source: sourcePath });
    const afterImport = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "assets" });
    expect(afterImport.data!.entries).toEqual(["photo.png"]);

    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    const afterUndo = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "assets" });
    expect(afterUndo.data!.entries).toEqual([]);

    const redone = await registry.dispatch("redo", { id });
    expect(redone.ok).toBe(true);
    const afterRedo = await registry.dispatch<{ entries: string[] }>("ls", { id, path: "assets" });
    expect(afterRedo.data!.entries).toEqual(["photo.png"]);
    expect(await readRealAssetBytes(id, "assets/photo.png")).toEqual(PNG_BYTES);
  });
});

describe("asset import — URL source", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/photo.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PNG_BYTES);
        return;
      }
      if (req.url === "/lying.png") {
        // Content-Type claims PNG, but the bytes are plain text — magic
        // bytes must win over the header (ADR-0010/0015).
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end("not actually a png");
        return;
      }
      if (req.url === "/error-page") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>not media</html>");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("downloads a real image and imports it", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch<{ path: string; mimeType: string }>("asset import", {
      id,
      source: `${baseUrl}/photo.png`,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ path: "assets/photo.png", mimeType: "image/png", kind: "image" });
  });

  it("rejects a response whose Content-Type lies about the bytes", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("asset import", { id, source: `${baseUrl}/lying.png` });

    expect(result.ok).toBe(false);
  });

  it("rejects a non-media response (e.g. an HTML error page)", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("asset import", { id, source: `${baseUrl}/error-page` });

    expect(result.ok).toBe(false);
  });

  it("fails with a clear error on a 404", async () => {
    const { id } = await openFreshPresentation();

    const result = await registry.dispatch("asset import", { id, source: `${baseUrl}/does-not-exist.png` });

    expect(result.ok).toBe(false);
  });
});
