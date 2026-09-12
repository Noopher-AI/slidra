import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * `POST /api/asset`. Seam B: the real server over real HTTP.
 * This is the front end's byte-upload path for drag/drop and clipboard
 * paste — `/api/command` cannot carry raw bytes (see asset-upload.ts's
 * module comment), so this is a second, narrower write route with the same
 * "server owns the presentation id" and "agent-freeze 409s it" posture as
 * command-endpoint.test.ts already proves for `/api/command`.
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

// The 8-byte PNG signature `detectMediaFormat` checks for — real decodable
// image data is not needed, only bytes that prove format detection ran on
// content, not on the claimed filename (mirrors packages/cli/test/asset-import.test.ts's PNG_BYTES).
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let slidraHome: string;
let slidraDir: string;
let staticRoot: string;
let servers: RunningServer[];

beforeEach(async () => {
  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-asset-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-asset-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "slidra-asset-static-"));
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
        name: "資產上傳測試",
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

async function listAssets(presentationId: string): Promise<string[]> {
  const result = await runCli<{ entries: string[] }>(["ls", presentationId, "assets"]);
  expect(result.ok).toBe(true);
  return result.data!.entries;
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

async function postAsset(
  server: RunningServer,
  body: Buffer | string,
  sourceName: string,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${server.url}/api/asset`, {
    method: "POST",
    headers: { "X-Slidra-Asset-Name": encodeURIComponent(sourceName) },
    body,
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

it("a valid PNG upload lands in assets/ and returns 200 with import data", async () => {
  const id = await openDeck("upload.slidra");
  const server = await serve(id);

  const { status, json } = await postAsset(server, PNG_BYTES, "photo.png");

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.data).toEqual({ path: "assets/photo.png", mimeType: "image/png", kind: "image" });

  expect(await listAssets(id)).toEqual(["photo.png"]);
});

it("plain text disguised with a .png extension returns 400, assets/ unchanged", async () => {
  const id = await openDeck("fake.slidra");
  const server = await serve(id);

  const { status, json } = await postAsset(server, "this is not a real image", "fake.png");

  expect(status).toBe(400);
  expect(json.error).toContain("不支援的媒體格式");
  expect(await listAssets(id)).toEqual([]);
});

it("returns 400 when the filename header is missing", async () => {
  const id = await openDeck("noname.slidra");
  const server = await serve(id);

  const response = await fetch(`${server.url}/api/asset`, { method: "POST", body: PNG_BYTES });

  expect(response.status).toBe(400);
});

it("an oversized body returns 400 and is never written to assets/", async () => {
  const id = await openDeck("big.slidra");
  const server = await serve(id);
  const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(32 * 1024 * 1024)]);

  const { status } = await postAsset(server, oversized, "huge.png");

  expect(status).toBe(400);
  expect(await listAssets(id)).toEqual([]);
});

describe("POST /api/asset — URL mode", () => {
  let sourceServer: http.Server;
  let sourceBaseUrl: string;

  beforeEach(async () => {
    sourceServer = http.createServer((req, res) => {
      if (req.url === "/photo.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PNG_BYTES);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
    const { port } = sourceServer.address() as AddressInfo;
    sourceBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
  });

  async function postAssetUrl(server: RunningServer, url: string): Promise<{ status: number; json: any }> {
    const response = await fetch(`${server.url}/api/asset`, {
      method: "POST",
      headers: { "X-Slidra-Asset-Url": encodeURIComponent(url) },
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

  it("downloads a real image and imports it, using the same format detection as asset import <url>", async () => {
    const id = await openDeck("url-upload.slidra");
    const server = await serve(id);

    const { status, json } = await postAssetUrl(server, `${sourceBaseUrl}/photo.png`);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ path: "assets/photo.png", mimeType: "image/png", kind: "image" });
    expect(await listAssets(id)).toEqual(["photo.png"]);
  });

  it("rejects a non-http(s) scheme (file:/relative path), landing no file", async () => {
    const id = await openDeck("url-scheme.slidra");
    const server = await serve(id);

    const { status, json } = await postAssetUrl(server, "file:///etc/passwd");

    expect(status).toBe(400);
    expect(json.error).toContain("http(s)");
    expect(await listAssets(id)).toEqual([]);
  });

  it("returns 400 when both filename and URL headers are given, without guessing which one wins", async () => {
    const id = await openDeck("url-both-headers.slidra");
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/asset`, {
      method: "POST",
      headers: {
        "X-Slidra-Asset-Name": encodeURIComponent("photo.png"),
        "X-Slidra-Asset-Url": encodeURIComponent(`${sourceBaseUrl}/photo.png`),
      },
      body: PNG_BYTES,
    });

    expect(response.status).toBe(400);
  });

  it("a failed download (404) returns 400, landing no file", async () => {
    const id = await openDeck("url-404.slidra");
    const server = await serve(id);

    const { status } = await postAssetUrl(server, `${sourceBaseUrl}/does-not-exist.png`);

    expect(status).toBe(400);
    expect(await listAssets(id)).toEqual([]);
  });
});
