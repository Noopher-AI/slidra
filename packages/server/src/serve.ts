import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRegistry } from "@co-motion/cli";
import { CoMotionError, validateProjectJson, type ProjectJson } from "@co-motion/core";
import { AgentChatSession, type AgentAdapterConfig } from "./agent/session.js";
import { openEventStream, type EventStream } from "./sse.js";
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
  /**
   * The already-selected ACP adapter to spawn on the first chat message.
   * Required: `cli.ts` always resolves one via `selectAdapter()` before
   * calling `startServe` (§3 — no fallback, no degraded mode), so "serve
   * without an agent" is not a state production ever reaches. Making this
   * required (rather than optional with a 500 fallback) makes that state
   * unrepresentable instead of merely unreached.
   */
  agent: AgentAdapterConfig;
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 5173;
const DEFAULT_HOST = "127.0.0.1";

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

  const chatSession = new AgentChatSession(options.agent);
  // Every SSE stream `/api/chat/stream` has ever opened, still connected.
  // `server.close()` waits for established connections rather than
  // closing them, and an SSE stream never ends on its own — so these must
  // be closed explicitly, before the socket itself is closed, or shutdown
  // hangs forever with a browser tab open.
  const liveChatStreams = new Set<EventStream>();
  disposers.push(async () => {
    for (const stream of liveChatStreams) {
      stream.close();
    }
    await chatSession.dispose();
  });

  // Starts watching only lazily, on the first /api/events connection (see
  // changes.ts) — creating the handle itself touches no filesystem, so no
  // rollback is needed if listen() below fails.
  const changeBroadcaster = createChangeBroadcaster(presentationId);
  disposers.push(() => changeBroadcaster.dispose());

  const server = http.createServer((req, res) => {
    void handleRequest(registry, presentationId, staticDir, chatSession, liveChatStreams, changeBroadcaster, req, res);
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
  // Structural validation is @co-motion/core's, not serve's own copy
  // (ticket #12) — the same check `open` already ran when the container
  // was first unpacked. Running it again here catches a work directory
  // whose project.json was mutated after `open` (e.g. by a future write
  // command) rather than trusting a shape that was only ever true once.
  return validateProjectJson(parsed);
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
  chatSession: AgentChatSession,
  liveChatStreams: Set<EventStream>,
  changeBroadcaster: ChangeBroadcaster,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    // Parsed before the method gate so POST /api/chat can be routed
    // explicitly — every other POST still gets the same 405 it always did.
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST") {
      if (url.pathname === "/api/chat") {
        await handleChatPost(chatSession, req, res);
        return;
      }
      sendJson(res, 405, { error: "只支援 GET" });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "只支援 GET" });
      return;
    }

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

    if (url.pathname === "/api/chat/stream") {
      handleChatStream(chatSession, res, liveChatStreams);
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

/**
 * `POST /api/chat` — accepts the author's message and returns immediately;
 * the reply is never awaited here, it streams separately over
 * `/api/chat/stream`.
 */
async function handleChatPost(
  chatSession: AgentChatSession,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "請求內容不是有效的 JSON" });
    return;
  }
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim() === "") {
    sendJson(res, 400, { error: "訊息內容不可為空" });
    return;
  }
  chatSession.sendMessage(text);
  sendJson(res, 202, { ok: true });
}

/**
 * `GET /api/chat/stream` — an SSE stream of the agent's reply. Event names:
 * `chat-chunk` (a reply-text delta), `chat-done` (the turn ended, carries
 * `stopReason`), `chat-error` (a clear-text failure, e.g. not logged in).
 */
function handleChatStream(chatSession: AgentChatSession, res: ServerResponse, liveStreams: Set<EventStream>): void {
  const stream = openEventStream(res);
  liveStreams.add(stream);
  const detach = chatSession.attachStream((event, data) => stream.send(event, data));
  res.once("close", () => {
    detach();
    liveStreams.delete(stream);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
