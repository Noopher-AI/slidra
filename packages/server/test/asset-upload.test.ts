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
const coMotionBinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../target/release/comotion");

interface CliEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
  failureKind?: string;
}

async function runCli<T = unknown>(args: string[]): Promise<CliEnvelope<T>> {
  try {
    const { stdout } = await execFileAsync(coMotionBinPath, [...args, "--json"], { env: process.env });
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
 * `POST /api/asset` (T3/NOOP-142). Seam B: the real server over real HTTP.
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

let coMotionHome: string;
let comotDir: string;
let staticRoot: string;
let servers: RunningServer[];

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "comotion-asset-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "comotion-asset-files-"));
  staticRoot = await mkdtemp(path.join(tmpdir(), "comotion-asset-static-"));
  process.env.COMOTION_HOME = coMotionHome;
  process.env.COMOTION_BIN = coMotionBinPath;
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  delete process.env.COMOTION_HOME;
  delete process.env.COMOTION_BIN;
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
        name: "資產上傳測試",
        canvas: { width: 1280, height: 720 },
        slides: ["slides/001.svg"],
      }),
    ),
    "slides/001.svg": new TextEncoder().encode(SLIDE),
  });
  const comotPath = path.join(comotDir, fileName);
  await writeFile(comotPath, zipped);
  const opened = await runCli<{ id: string }>(["open", comotPath]);
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
    headers: { "X-Comotion-Asset-Name": encodeURIComponent(sourceName) },
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

it("合法 PNG 上傳落地到 assets/ 並回 200 與匯入資料", async () => {
  const id = await openDeck("upload.comot");
  const server = await serve(id);

  const { status, json } = await postAsset(server, PNG_BYTES, "photo.png");

  expect(status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.data).toEqual({ path: "assets/photo.png", mimeType: "image/png", kind: "image" });

  expect(await listAssets(id)).toEqual(["photo.png"]);
});

it("副檔名偽裝成 .png 的純文字內容回 400，assets/ 不變", async () => {
  const id = await openDeck("fake.comot");
  const server = await serve(id);

  const { status, json } = await postAsset(server, "this is not a real image", "fake.png");

  expect(status).toBe(400);
  expect(json.error).toContain("不支援的媒體格式");
  expect(await listAssets(id)).toEqual([]);
});

it("缺少檔名標頭回 400", async () => {
  const id = await openDeck("noname.comot");
  const server = await serve(id);

  const response = await fetch(`${server.url}/api/asset`, { method: "POST", body: PNG_BYTES });

  expect(response.status).toBe(400);
});

it("超過上限的 body 回 400，且不會寫入 assets/", async () => {
  const id = await openDeck("big.comot");
  const server = await serve(id);
  const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(32 * 1024 * 1024)]);

  const { status } = await postAsset(server, oversized, "huge.png");

  expect(status).toBe(400);
  expect(await listAssets(id)).toEqual([]);
});

describe("POST /api/asset — URL 模式（[E2.T17] plan §4.3/D5）", () => {
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
      headers: { "X-Comotion-Asset-Url": encodeURIComponent(url) },
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

  it("下載一張真實圖片並匯入，走與 asset import <url> 相同的格式偵測", async () => {
    const id = await openDeck("url-upload.comot");
    const server = await serve(id);

    const { status, json } = await postAssetUrl(server, `${sourceBaseUrl}/photo.png`);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ path: "assets/photo.png", mimeType: "image/png", kind: "image" });
    expect(await listAssets(id)).toEqual(["photo.png"]);
  });

  it("拒絕非 http(s) 的 scheme（file:／相對路徑），不落地任何檔案", async () => {
    const id = await openDeck("url-scheme.comot");
    const server = await serve(id);

    const { status, json } = await postAssetUrl(server, "file:///etc/passwd");

    expect(status).toBe(400);
    expect(json.error).toContain("http(s)");
    expect(await listAssets(id)).toEqual([]);
  });

  it("同時提供檔名與 URL 兩個標頭時回 400，不猜哪個優先", async () => {
    const id = await openDeck("url-both-headers.comot");
    const server = await serve(id);

    const response = await fetch(`${server.url}/api/asset`, {
      method: "POST",
      headers: {
        "X-Comotion-Asset-Name": encodeURIComponent("photo.png"),
        "X-Comotion-Asset-Url": encodeURIComponent(`${sourceBaseUrl}/photo.png`),
      },
      body: PNG_BYTES,
    });

    expect(response.status).toBe(400);
  });

  it("下載失敗（404）回 400，不落地任何檔案", async () => {
    const id = await openDeck("url-404.comot");
    const server = await serve(id);

    const { status } = await postAssetUrl(server, `${sourceBaseUrl}/does-not-exist.png`);

    expect(status).toBe(400);
    expect(await listAssets(id)).toEqual([]);
  });
});
