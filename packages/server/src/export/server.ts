// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDeckServer, forwardDeckServerGet, type DeckServerClient } from "../deck-server-client.js";

/**
 * The CLI's own minimal HTTP server for `slidra export` (NOOP-93 §3.6).
 *
 * `slidra export` runs standalone — there is no already-running
 * `slidra serve` to piggyback on, and `startServe` cannot be reused for
 * it: `ServeOptions.agent` is required with no fallback (`serve.ts:44-52`'s
 * own comment says this is deliberate), so faking an adapter just to
 * satisfy the type would be lying to the type system for a feature
 * (chat/agent) the export page never uses. The GUI path (`POST
 * /api/export` on an already-running `serve`) does NOT use this file at
 * all — it points `render.ts` at that server's own URL, which already
 * serves `export.html` (the same `packages/web/dist` Next.js static export)
 * and the same three read-only routes.
 *
 * Exactly five things this server answers: static files (`export.html` and
 * its chunks), `GET /api/presentation`, `GET /api/files/<path>`,
 * `GET /api/effects/<path>` ([E4.T7] — the step-by-step export entry point
 * needs the same plan the player does), and `GET /api/raw/<path>` — the
 * four read-only routes forwarded to the crate's own deck server
 * ([E10.T5], `deck-server-client.ts`, shared with `serve.ts`'s identical
 * forwarding for the same routes — never duplicated, so the two can never
 * drift), reached through this file's own tiny routing/static-serving
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

  // [E10.T5]: same transitional forwarding layer as serve.ts's own
  // (`deck-server-client.ts`) — this standalone export server has no
  // `deckSession` at all (`presentationId` is fixed for its whole
  // lifetime), so there is exactly one workbench id to forward every
  // request with.
  const deckServer = await startDeckServer();

  const server = http.createServer((req, res) => {
    void handleRequest(presentationId, staticDir, deckServer, req, res);
  });

  try {
    await listen(server, options.port ?? 0, host);
  } catch (error) {
    await deckServer.close();
    throw error;
  }
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
      }).then(() => deckServer.close()),
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
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    // Same gate serve.ts's handleRequest applies, for the same reason
    // (ADR-0007): the stacked play iframes are opaque-origin and their
    // @font-face fetch is the one legitimate `Origin: null` request this
    // server ever sees.
    if (req.headers.origin === "null" && !(req.url ?? "").startsWith("/api/raw/")) {
      sendJson(res, 403, { error: "Does not accept requests from an opaque origin (Origin: null)" });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Only GET is supported" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/presentation") {
      await forwardDeckServerGet(deckServer, "/presentation", presentationId, res);
      return;
    }
    if (url.pathname.startsWith("/api/files/")) {
      const encodedPath = url.pathname.slice("/api/files/".length);
      await forwardDeckServerGet(deckServer, `/files/${encodedPath}`, presentationId, res);
      return;
    }
    if (url.pathname.startsWith("/api/effects/")) {
      const encodedPath = url.pathname.slice("/api/effects/".length);
      await forwardDeckServerGet(deckServer, `/effects/${encodedPath}`, presentationId, res);
      return;
    }
    if (url.pathname.startsWith("/api/raw/")) {
      const encodedPath = url.pathname.slice("/api/raw/".length);
      const extraHeaders: Record<string, string> = {};
      if (req.headers.range !== undefined) extraHeaders.range = req.headers.range;
      res.setHeader("Access-Control-Allow-Origin", "*");
      await forwardDeckServerGet(deckServer, `/raw/${encodedPath}`, presentationId, res, extraHeaders);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Endpoint not found" });
      return;
    }

    await serveStatic(staticDir, url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** `packages/web/dist` — this file lives at `packages/server/src/export/`, three directories below `packages/`. */
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
      sendJson(res, 500, { error: "Failed to read static file" });
      return;
    }
    if (isRoot) {
      sendJson(res, 500, { error: "Frontend has not been built yet, run build first" });
      return;
    }
    sendJson(res, 404, { error: "file not found" });
  }
}

function staticContentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  return "application/octet-stream";
}
