import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRegistry } from "@co-motion/cli";
import { CoMotionError, undoLastGroup, redoLastGroup, validateProjectJson, type ProjectJson } from "@co-motion/core";
import { AgentChatSession, type AgentAdapterConfig } from "./agent/session.js";
import { openEventStream, type EventStream } from "./sse.js";
import { createChangeBroadcaster } from "./changes.js";
import type { ChangeBroadcaster } from "./changes.js";
import { handleRawRequest } from "./raw.js";
import { EditingLock, EditingLockConflictError } from "./editing-lock.js";

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
  /**
   * Directory the built frontend is served from. Omitted everywhere in
   * production (`cli.ts`, the e2e smoke test), where it resolves to the
   * real `packages/web/dist` exactly as before.
   *
   * It exists so tests have somewhere else to write. Without it the
   * static-serving tests had no choice but to populate the real build
   * output and then delete it, which is why `npm test` used to destroy
   * what `npm run test:e2e` needs (ticket #20). A per-test temp directory
   * makes that collision impossible rather than merely discouraged.
   */
  staticDir?: string;
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

  const staticDir = options.staticDir ?? resolveWebDist();

  // Resources started alongside the HTTP server. close() tears them down in
  // registration order, before the socket itself is closed.
  const disposers: Array<() => Promise<void>> = [];

  // T5 (NOOP-93/#110): single-editor lock, shared by the agent turn
  // lifecycle (AgentChatSession) and the human editing routes below. Its
  // frozen/unfrozen events are forwarded onto the same /api/events fan-out
  // `presentation-changed` already uses — no second SSE stream.
  const editingLock = new EditingLock();
  const chatSession = new AgentChatSession(options.agent, presentationId, editingLock);
  // Every SSE stream `/api/chat/stream` has ever opened, still connected.
  // `server.close()` waits for established connections rather than
  // closing them, and an SSE stream never ends on its own — so these must
  // be closed explicitly, before the socket itself is closed, or shutdown
  // hangs forever with a browser tab open.
  const chatStreams = createChatStreamRegistry();
  disposers.push(async () => {
    chatStreams.closeAll();
    await chatSession.dispose();
  });

  // Starts watching only lazily, on the first /api/events connection (see
  // changes.ts) — creating the handle itself touches no filesystem, so no
  // rollback is needed if listen() below fails.
  const changeBroadcaster = createChangeBroadcaster(presentationId);
  disposers.push(() => changeBroadcaster.dispose());

  const onFrozen = () => changeBroadcaster.broadcast("editing-frozen", {});
  const onUnfrozen = () => changeBroadcaster.broadcast("editing-unfrozen", {});
  editingLock.on("frozen", onFrozen);
  editingLock.on("unfrozen", onUnfrozen);
  disposers.push(async () => {
    editingLock.off("frozen", onFrozen);
    editingLock.off("unfrozen", onUnfrozen);
  });

  const server = http.createServer((req, res) => {
    void handleRequest(
      registry,
      presentationId,
      staticDir,
      chatSession,
      chatStreams,
      changeBroadcaster,
      editingLock,
      req,
      res,
    );
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
        // server.close() stops accepting new connections and closes idle
        // ones on its own (Node >=18.19), but still waits indefinitely for
        // any connection that is genuinely active — a request still
        // arriving, or a response that has been opened and never ended.
        // `disposers` above only closes the SSE streams this server itself
        // tracks; anything else still active at this moment (e.g. a request
        // that never finished arriving) would otherwise block shutdown
        // forever. This forcibly severs whatever is left, right after
        // close() has already stopped accepting new connections.
        server.closeAllConnections();
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
  chatStreams: ChatStreamRegistry,
  changeBroadcaster: ChangeBroadcaster,
  editingLock: EditingLock,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    // ADR-0010: 播放模式 gives the (untrusted, ADR-0003) slide's iframe
    // `allow-scripts`, which puts it in an opaque origin. An opaque origin
    // can still send cross-origin *simple* requests — it cannot read the
    // response, but it can write — so a hostile slide could otherwise fire
    // requests at this same-origin API and mutate the presentation blind.
    // Every browser sends the literal string "null" as `Origin` for a
    // request from an opaque origin, so rejecting exactly that value closes
    // the gap. Checked ahead of every route, including static asset
    // serving, so the next new route gets the protection for free instead
    // of by remembering to add it again.
    //
    // No-CORS subresource loads (<img>, <video>, <audio> — what the play
    // iframe's own slide markup uses to fetch assets through /api/raw/)
    // send no Origin header at all, confirmed empirically against a real
    // browser in e2e/player.test.ts, so this gate does not touch them.
    //
    // `@font-face src: url(...)` is the one subresource load browsers fetch
    // in CORS mode rather than no-cors — it sends `Origin: null` from an
    // opaque srcdoc iframe (ticket #71's canvas/overview/play wrappers all
    // inject one pointing at `/api/raw/fonts/...`). `/api/raw/` is GET-only
    // and already deliberately public read access gated only by an
    // unguessable presentation id (see the ACAO header set below), so it
    // carries none of the "opaque origin can still mutate blind" risk this
    // gate exists for — exempting it here is what makes that header not
    // dead code.
    if (req.headers.origin === "null" && !(req.url ?? "").startsWith("/api/raw/")) {
      sendJson(res, 403, { error: "不接受來自不透明來源（Origin: null）的請求" });
      return;
    }

    // Parsed before the method gate so POST /api/chat can be routed
    // explicitly — every other POST still gets the same 405 it always did.
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST") {
      if (url.pathname === "/api/chat") {
        await handleChatPost(chatSession, req, res);
        return;
      }
      if (url.pathname === "/api/undo") {
        await handleUndoRedoPost(editingLock, presentationId, undoLastGroup, res);
        return;
      }
      if (url.pathname === "/api/redo") {
        await handleUndoRedoPost(editingLock, presentationId, redoLastGroup, res);
        return;
      }
      if (url.pathname === "/api/editing/begin") {
        handleEditingBeginPost(editingLock, res);
        return;
      }
      if (url.pathname === "/api/editing/end") {
        editingLock.endHumanEdit();
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: "只支援 GET" });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "只支援 GET" });
      return;
    }

    if (url.pathname === "/api/editing") {
      sendJson(res, 200, { frozen: editingLock.getState() === "agent" });
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
      // A slide path is rendered for display — `{{ slide_number }}` and its
      // siblings substituted (NOOP-90/T4) — while every other path
      // (project.json, assets/*) keeps reading through `cat` unchanged.
      // Loading the project to make this check is not a new failure mode:
      // `loadProject` already dispatches "cat" on project.json the same way
      // every other route on this server does before it can answer anything.
      const project = await loadProject(registry, presentationId);
      const commandName = project.slides.includes(virtualPath) ? "slide render" : "cat";
      const result = await registry.dispatch<{ content: string }>(commandName, {
        id: presentationId,
        path: virtualPath,
      });
      if (!result.ok) {
        // Same narrow classification `/api/raw/` uses (ticket #11): only a
        // failure that positively proves absence is a 404. Everything else
        // — an unreadable file, a corrupt registry, a failure kind nobody
        // has taught this route about yet, or a handler that returned
        // `{ ok: false }` with no kind at all — is a 500, because "not
        // classified as not-found" is not evidence the file is missing.
        // Telling the author "找不到檔案" when the real problem is a
        // permission bit sends them looking in entirely the wrong place
        // (ticket #14). The body stays `result.message` either way, which
        // like every CoMotionError message never contains a real
        // filesystem path (ADR-0004) — only the virtual path may appear.
        const status = result.failureKind === "not-found" ? 404 : 500;
        sendJson(res, status, { error: result.message });
        return;
      }
      res.writeHead(200, { "Content-Type": contentTypeFor(virtualPath) });
      res.end(result.data!.content);
      return;
    }

    if (url.pathname === "/api/chat/stream") {
      chatStreams.open(chatSession, res);
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
      // The srcdoc iframe (canvas.ts) is an opaque-origin document (ADR-0009
      // sandboxing), so its @font-face url("/api/raw/fonts/...") load is a
      // cross-origin fetch even though it targets this same server —
      // without this header the browser silently refuses to use the font,
      // slides fall back to the system font, and A2/A5 (ticket #71) fail
      // with no visible error. `*` is safe here: every /api/raw/ response
      // is either public asset bytes gated only by knowing an opaque
      // presentation id, or a 404, never anything credentialed.
      res.setHeader("Access-Control-Allow-Origin", "*");
      // The Range header is read here, at the one place that has `req`, and
      // handed on as a plain value: handleRawRequest stays a function of
      // (path, response, range) rather than growing a dependency on the
      // whole request object it has no other use for (ticket #13).
      await handleRawRequest(presentationId, virtualPath, res, req.headers.range);
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
 * `POST /api/undo` and `POST /api/redo` (T5, NOOP-93/#110). Both are human
 * editing requests in the single-editor-lock sense (plan §4.1): refused
 * with 409 while the agent holds the floor, run unconditionally otherwise
 * — `undoLastGroup`/`redoLastGroup` themselves throw the "沒有可復原/重做的
 * 操作" `CoMotionError` on an empty stack, relayed here as 400 with the
 * core message verbatim rather than a silent 200.
 */
async function handleUndoRedoPost(
  editingLock: EditingLock,
  presentationId: string,
  run: (id: string) => Promise<{ restoredPaths: string[] }>,
  res: ServerResponse,
): Promise<void> {
  if (editingLock.getState() === "agent") {
    sendJson(res, 409, { error: new EditingLockConflictError().message });
    return;
  }
  try {
    const result = await run(presentationId);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof CoMotionError ? error.message : "無法完成操作" });
  }
}

/**
 * `POST /api/editing/begin` — the lease T2 (NOOP-91)'s drag UI is meant to
 * take/renew (plan §4.1). Refused with 409 while the agent holds the
 * floor; otherwise starts (or renews) the human lease and returns 200.
 */
function handleEditingBeginPost(editingLock: EditingLock, res: ServerResponse): void {
  try {
    editingLock.beginHumanEdit();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    if (error instanceof EditingLockConflictError) {
      sendJson(res, 409, { error: error.message });
      return;
    }
    throw error;
  }
}

export type ChatStreamRegistry = ReturnType<typeof createChatStreamRegistry>;

/**
 * The `/api/chat/stream` streams this server has open, together with the
 * shutdown state that guards them.
 *
 * The two belong in one place (ticket #40). `server.close()` waits for
 * established connections rather than closing them, and an SSE stream never
 * ends on its own — so shutdown must close every stream explicitly, before
 * the socket closes, or it hangs forever with a browser tab open. But
 * closing them is not enough on its own: a browser's EventSource treats
 * that close as a network blip and reconnects by design, and the disposer
 * loop in `close()` genuinely awaits things afterwards. A reconnect landing
 * in that window used to open a brand new stream and add it to a set that
 * had already been iterated — a stream nobody would ever close again, which
 * is the mechanism behind the 240s shutdown hang observed in ticket #37.
 *
 * Keeping `closing` here makes that impossible to reintroduce: `closeAll()`
 * is the only way to close the streams and it latches the guard in the same
 * breath, so the flag and the teardown cannot drift apart. `changes.ts`
 * refuses a connection in exactly this situation; this is the other half of
 * that symmetry.
 */
export function createChatStreamRegistry() {
  const streams = new Set<EventStream>();
  let closing = false;

  return {
    /**
     * `GET /api/chat/stream` — an SSE stream of the agent's reply. Event
     * names: `chat-chunk` (a reply-text delta), `chat-done` (the turn
     * ended, carries `stopReason`), `chat-error` (a clear-text failure,
     * e.g. not logged in).
     *
     * Throws once shutdown has started, rather than handing the client a
     * 200 that will never carry a single byte.
     */
    open(chatSession: AgentChatSession, res: ServerResponse): void {
      if (closing) {
        throw new CoMotionError("伺服器正在關閉");
      }
      const stream = openEventStream(res);
      streams.add(stream);
      const detach = chatSession.attachStream((event, data) => stream.send(event, data));
      res.once("close", () => {
        detach();
        streams.delete(stream);
      });
    },

    /** Closes every live stream and refuses every later one. */
    closeAll(): void {
      closing = true;
      for (const stream of streams) {
        stream.close();
      }
      streams.clear();
    },
  };
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
