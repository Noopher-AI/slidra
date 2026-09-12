import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleEffectsRoute, handleFilesRoute, handlePresentationRoute, handleRawRoute } from "../read-routes.js";

/**
 * The CLI's own minimal HTTP server for `comotion export` (NOOP-93 §3.6).
 *
 * `comotion export` runs standalone — there is no already-running
 * `comotion serve` to piggyback on, and `startServe` cannot be reused for
 * it: `ServeOptions.agent` is required with no fallback (`serve.ts:44-52`'s
 * own comment says this is deliberate), so faking an adapter just to
 * satisfy the type would be lying to the type system for a feature
 * (chat/agent) the export page never uses. The GUI path (`POST
 * /api/export` on an already-running `serve`) does NOT use this file at
 * all — it points `render.ts` at that server's own URL, which already
 * serves `export.html` (the same `apps/web/dist` build, now built with
 * two Vite entries) and the same three read-only routes.
 *
 * Exactly five things this server answers: static files (`export.html` and
 * its chunks), `GET /api/presentation`, `GET /api/files/<path>`,
 * `GET /api/effects/<path>` ([E4.T7] — the step-by-step export entry point
 * needs the same plan the player does), and `GET /api/raw/<path>` — the
 * four read-only routes shared with `serve.ts` via `read-routes.ts` (never
 * duplicated — see that module's own comment for why drift there is
 * dangerous), reached through this file's own tiny routing/static-serving
 * plumbing, which is NOT shared with `serve.ts` (a deliberate choice, not
 * an oversight — this server carries none of `serve.ts`'s write routes,
 * chat session, or editing lock).
 */
export interface ExportServerOptions {
  presentationId: string;
  /** Defaults to an OS-assigned ephemeral port — this is a private, short-lived server for one export run, never a long-lived service with a fixed address to remember. */
  port?: number;
  host?: string;
  /** Same escape hatch `ServeOptions.staticDir` gives tests — see its comment. */
  staticDir?: string;
}

export interface RunningExportServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";

export async function startExportServer(options: ExportServerOptions): Promise<RunningExportServer> {
  const { presentationId } = options;
  const host = options.host ?? DEFAULT_HOST;
  const staticDir = options.staticDir ?? resolveWebDist();

  const server = http.createServer((req, res) => {
    void handleRequest(presentationId, staticDir, req, res);
  });

  await listen(server, options.port ?? 0, host);
  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Same reasoning as serve.ts's own close(): a page load or a still-
        // open connection must not hang shutdown of a server nobody will
        // ever ask anything of again.
        server.closeAllConnections();
      }),
  };
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.removeListener("error", reject);
      resolve();
    });
    server.listen(port, host);
  });
}

async function handleRequest(
  presentationId: string,
  staticDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    // Same gate serve.ts's handleRequest applies, for the same reason
    // (ADR-0010): the stacked play iframes are opaque-origin and their
    // @font-face fetch is the one legitimate `Origin: null` request this
    // server ever sees.
    if (req.headers.origin === "null" && !(req.url ?? "").startsWith("/api/raw/")) {
      sendJson(res, 403, { error: "不接受來自不透明來源（Origin: null）的請求" });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "只支援 GET" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/presentation") {
      await handlePresentationRoute(presentationId, res);
      return;
    }
    if (url.pathname.startsWith("/api/files/")) {
      const virtualPath = decodeURIComponent(url.pathname.slice("/api/files/".length));
      await handleFilesRoute(presentationId, virtualPath, res);
      return;
    }
    if (url.pathname.startsWith("/api/effects/")) {
      const virtualPath = decodeURIComponent(url.pathname.slice("/api/effects/".length));
      await handleEffectsRoute(presentationId, virtualPath, res);
      return;
    }
    if (url.pathname.startsWith("/api/raw/")) {
      let virtualPath: string;
      try {
        virtualPath = decodeURIComponent(url.pathname.slice("/api/raw/".length));
      } catch {
        sendJson(res, 400, { error: "路徑編碼無效" });
        return;
      }
      await handleRawRoute(presentationId, virtualPath, res, req.headers.range);
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

/** `apps/web/dist` — this file lives at `packages/server/src/export/`, three directories below `packages/`. */
function resolveWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "../../../web/dist");
}

/** `export.html` is the only page this server ever needs to serve at `/` — there is no SPA router here, unlike serve.ts's index.html. */
async function serveStatic(staticDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const isRoot = pathname === "/";
  const relative = isRoot ? "export.html" : pathname.replace(/^\/+/, "");
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      sendJson(res, 500, { error: "靜態檔案讀取失敗" });
      return;
    }
    if (isRoot) {
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
