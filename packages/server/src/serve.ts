import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRegistry } from "@co-motion/cli";
import { CoMotionError } from "@co-motion/core";
import { createChangeBroadcaster } from "./changes.js";
import type { ChangeBroadcaster } from "./changes.js";
import { handleRawRequest } from "./raw.js";

/**
 * `co-motion serve` is a mode of the CLI, not a second backend (ADR-0002):
 * every read of presentation content goes through `registry.dispatch`, the
 * exact call one-shot `co-motion cat`/`ls` use. This module never opens a
 * file directly and never calls `registry.getRenderer` — renderers are
 * terminal formatting, none of serve's business.
 */
export interface ServeOptions {
  /** The same registry `createDefaultRegistry()` builds for the one-shot CLI. */
  registry: CommandRegistry;
  /** Opaque id of an already-opened presentation (see `co-motion open`). */
  presentationId: string;
  /**
   * Port to bind. Defaults to 5173. Tests must always pass 0 (let the OS
   * assign a free port) and read the actual port back from the result —
   * never hardcode a port, or concurrent test suites collide.
   */
  port?: number;
  host?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 5173;
const DEFAULT_HOST = "127.0.0.1";

interface ProjectJson {
  formatVersion: number;
  name: string;
  canvas: { width: number; height: number };
  slides: string[];
}

/**
 * Validates the presentation and starts the HTTP server. Validation
 * (unknown id, no slides) happens before the socket is ever bound, so a
 * bad startup fails loudly without a half-started server left behind.
 */
export async function startServe(options: ServeOptions): Promise<RunningServer> {
  const { registry, presentationId } = options;
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  const project = await loadProject(registry, presentationId);
  if (project.slides.length === 0) {
    throw new CoMotionError("簡報沒有投影片");
  }

  const staticDir = resolveWebDist();

  // Resources started alongside the HTTP server. close() tears them down in
  // registration order, before the socket itself is closed.
  const disposers: Array<() => Promise<void>> = [];

  // Starts watching only lazily, on the first /api/events connection (see
  // changes.ts) — creating the handle itself touches no filesystem, so no
  // rollback is needed if listen() below fails.
  const changeBroadcaster = createChangeBroadcaster(presentationId);
  disposers.push(() => changeBroadcaster.dispose());

  const server = http.createServer((req, res) => {
    void handleRequest(registry, presentationId, staticDir, changeBroadcaster, req, res);
  });

  await listen(server, port, host);
  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      for (const dispose of disposers) {
        await dispose();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function loadProject(registry: CommandRegistry, id: string): Promise<ProjectJson> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "project.json" });
  if (!result.ok) {
    // Reuse the registry's own message (e.g. "找不到識別碼對應的簡報：<id>")
    // instead of inventing a second wording for the same failure.
    throw new CoMotionError(result.message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data!.content);
  } catch {
    throw new CoMotionError("簡報的 project.json 無法解析");
  }
  return validateProjectJson(parsed);
}

/**
 * Structural validation of a parsed `project.json`, staged here rather than
 * in `packages/core`'s container module because that module is mid-edit on
 * another branch right now — this is a temporary home, not the intended
 * one. The container format only guarantees `formatVersion`; every other
 * field the server relies on is checked explicitly here, with no defaults
 * and no guessing, so a corrupt or schema-drifted project.json fails with a
 * named cause instead of a raw TypeError downstream.
 */
function validateProjectJson(value: unknown): ProjectJson {
  if (typeof value !== "object" || value === null) {
    throw new CoMotionError("簡報的 project.json 格式錯誤：內容不是物件");
  }
  const record = value as Record<string, unknown>;

  if (typeof record.formatVersion !== "number") {
    throw new CoMotionError("簡報的 project.json 格式錯誤：缺少或型別錯誤的 formatVersion");
  }
  if (typeof record.name !== "string") {
    throw new CoMotionError("簡報的 project.json 格式錯誤：缺少或型別錯誤的 name");
  }
  if (
    typeof record.canvas !== "object" ||
    record.canvas === null ||
    typeof (record.canvas as Record<string, unknown>).width !== "number" ||
    typeof (record.canvas as Record<string, unknown>).height !== "number"
  ) {
    throw new CoMotionError("簡報的 project.json 格式錯誤：缺少或型別錯誤的 canvas");
  }
  if (!Array.isArray(record.slides)) {
    throw new CoMotionError("簡報的 project.json 格式錯誤：slides 不是陣列");
  }
  if (!record.slides.every((slide) => typeof slide === "string")) {
    throw new CoMotionError("簡報的 project.json 格式錯誤：slides 內含無效項目");
  }

  return record as unknown as ProjectJson;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") {
        // Never fall back to another port — a user who asked for a specific
        // port and silently got another has been lied to.
        reject(new CoMotionError(`連接埠已被使用：${port}`));
      } else {
        reject(error);
      }
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function handleRequest(
  registry: CommandRegistry,
  presentationId: string,
  staticDir: string,
  changeBroadcaster: ChangeBroadcaster,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "只支援 GET" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/presentation") {
      const project = await loadProject(registry, presentationId);
      sendJson(res, 200, project);
      return;
    }

    if (url.pathname.startsWith("/api/files/")) {
      // The virtual path space is the only path space (ADR-0004): whatever
      // the caller asks for goes straight into `cat`'s virtual-path lookup,
      // which structurally cannot resolve outside the presentation. There is
      // no separate "escape" case to special-case here — it is just another
      // not-found.
      const virtualPath = decodeURIComponent(url.pathname.slice("/api/files/".length));
      const result = await registry.dispatch<{ content: string }>("cat", {
        id: presentationId,
        path: virtualPath,
      });
      if (!result.ok) {
        sendJson(res, 404, { error: result.message });
        return;
      }
      res.writeHead(200, { "Content-Type": contentTypeFor(virtualPath) });
      res.end(result.data!.content);
      return;
    }

    if (url.pathname === "/api/events") {
      // Live reload push (ticket #5): opens a long-lived SSE stream. Never
      // returns/closes `res` itself — handleConnection hands it to
      // openEventStream, which owns the response from here on.
      await changeBroadcaster.handleConnection(res);
      return;
    }

    if (url.pathname.startsWith("/api/raw/")) {
      // Deliberately NOT `registry.dispatch`, unlike every other read in
      // this file. `dispatch` runs a registered CLI command, and every
      // registered command is reachable by the agent (ADR-0004's
      // permission hook allows `co-motion *`). A byte-preserving read
      // registered as a command would hand the agent the exact capability
      // ticket #2 closed off — dozens of MB of raw video/image bytes
      // dumped into its context. Browsers, not agents, need this route, so
      // it calls the core byte-read directly. It still goes through the
      // same virtual-path tree lookup as every other read
      // (readPresentationFileBytes -> readVirtualFileBytes), so
      // containment stays structural even though dispatch is bypassed.
      let virtualPath: string;
      try {
        virtualPath = decodeURIComponent(url.pathname.slice("/api/raw/".length));
      } catch {
        sendJson(res, 400, { error: "路徑編碼無效" });
        return;
      }
      await handleRawRequest(presentationId, virtualPath, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "找不到端點" });
      return;
    }

    await serveStatic(staticDir, url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "未知錯誤" });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function contentTypeFor(virtualPath: string): string {
  if (virtualPath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (virtualPath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/**
 * Resolves the built frontend's static directory (packages/web/dist),
 * relative to this module's own location so it works regardless of the
 * caller's cwd. The directory need not exist yet — `serveStatic` falls back
 * to an explicit error when it doesn't, which is all Seam B tests exercise;
 * only a real browser (ticket #8) needs the built assets to be present.
 */
function resolveWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "../../web/dist");
}

async function serveStatic(staticDir: string, pathname: string, res: ServerResponse): Promise<void> {
  // The frontend has no client-side router, so the root path is the only
  // request that maps to index.html; every other path names a concrete
  // static asset and gets exactly that asset or an explicit failure — no
  // catch-all SPA fallback that would disguise a missing bundle as success.
  const isRoot = pathname === "/";
  const relative = isRoot ? "index.html" : pathname.replace(/^\/+/, "");
  // Confine lookups to staticDir: collapse ".." segments away rather than
  // resolving them, the same discipline the virtual filesystem uses.
  const safeRelative = path
    .normalize(relative)
    .split(path.sep)
    .filter((segment) => segment !== "" && segment !== "..")
    .join(path.sep);
  const filePath = path.join(staticDir, safeRelative);

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": staticContentTypeFor(filePath) });
    res.end(data);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // A real I/O failure (permissions, etc.) — never disguise it as a
      // successful page load.
      sendJson(res, 500, { error: "靜態檔案讀取失敗" });
      return;
    }
    if (isRoot) {
      // index.html itself is missing: the frontend was never built at all.
      sendJson(res, 500, { error: "前端尚未建置，請先執行 build" });
      return;
    }
    sendJson(res, 404, { error: "找不到檔案" });
  }
}

function staticContentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  return "application/octet-stream";
}
