import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRegistry } from "@co-motion/cli";
import {
  CoMotionError,
  CoMotionInvalidRequestError,
  readDefaultFontBytes,
  undoLastGroup,
  redoLastGroup,
  readSaveState,
  savePresentation,
  resolveCoMotionHome,
} from "@co-motion/core";
import type { AgentAdapterConfig } from "./agent/session.js";
import { collectSlashCommands, resolveSkillDirs, type SkillDirs, type SlashCommand } from "./agent/commands.js";
import { deployAgentWorkdir } from "./agent/workdir.js";
import { AgentManager, AgentSwitchLockedError, type AgentSource } from "./agent/manager.js";
import { resolveAdapterConfig, type AgentKind } from "./agent/adapters.js";
import type { CommandRunner } from "./agent/probe.js";
import { openEventStream, type EventStream } from "./sse.js";
import { createChangeBroadcaster } from "./changes.js";
import type { ChangeBroadcaster } from "./changes.js";
import { handleCommandPost } from "./command-endpoint.js";
import { handleAssetPost } from "./asset-upload.js";
import { handleOpenPost } from "./open-endpoint.js";
import { broadcastSaveState } from "./save-state.js";
import { EditingLock, EditingLockConflictError } from "./editing-lock.js";
import {
  handleEffectsRoute,
  handleFilesRoute,
  handlePresentationRoute,
  handleRawRoute,
  loadProject,
} from "./read-routes.js";
import { ExportJobManager, type ExportFormat } from "./export/job.js";
import { renderExportPdf } from "./export/render.js";
import { exportFileName } from "./export/output-name.js";

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
   * An already-selected ACP adapter to spawn immediately, treated as
   * `source: "cli"` for whichever kind it names.
   *
   * NOOP-230: no longer required — "no agent selected yet" is now a fully
   * supported state (serve always starts; see `initialAgent` below), so
   * this field alone can no longer express everything callers need. It is
   * kept, and kept optional-but-still-authoritative for its own kind,
   * purely for backward compatibility: five existing test suites and the
   * e2e harness (`e2e/helpers/launch.ts`) already construct one directly
   * and must keep working unchanged. When both this and `initialAgent` are
   * given, `initialAgent` wins.
   */
  agent?: AgentAdapterConfig;
  /**
   * What agent (if any) `serve` starts already pointed at, and why
   * (`AgentSource` — NOOP-230 §4.3). This is `cli.ts`'s way of handing
   * over what it resolved from `--agent`/`settings.json`. Omitted, with
   * `agent` also omitted, means no agent is selected — chat stays gated
   * off (409) until `POST /api/agent/select` picks one; every other route
   * works as usual.
   */
  initialAgent?: { kind: AgentKind | null; source: AgentSource };
  /**
   * Test-only injection seams for `AgentManager`'s login probe and adapter
   * resolution (`probe.ts`/`adapters.ts`). Production code (`cli.ts`) never
   * sets this — real serve always probes the real CLIs and resolves the
   * real adapter packages from `node_modules`.
   */
  agentManager?: {
    runCommand?: CommandRunner;
    resolveAdapter?: (kind: AgentKind) => AgentAdapterConfig;
  };
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
  /**
   * Overrides for the two skill directories `GET /api/agent/commands` and
   * the `agent-commands` SSE event scan (architecture decision on
   * #232/#236). Omitted in production (`cli.ts`), where both resolve to
   * their real defaults (see `resolveSkillDirs`). Tests always pass this —
   * relying on `homedir()` would leak whatever `~/.claude/skills` happens
   * to exist on the machine running the test into assertions.
   */
  skillDirs?: Partial<SkillDirs>;
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
  const agentWorkdir = await deployAgentWorkdir();

  const staticDir = options.staticDir ?? resolveWebDist();

  // Resources started alongside the HTTP server. close() tears them down in
  // registration order, before the socket itself is closed.
  const disposers: Array<() => Promise<void>> = [];

  // T5 (NOOP-93/#110): single-editor lock, shared by the agent turn
  // lifecycle (AgentManager -> AgentChatSession) and the human editing
  // routes below. Its frozen/unfrozen events are forwarded onto the same
  // /api/events fan-out `presentation-changed` already uses — no second SSE
  // stream.
  const editingLock = new EditingLock();

  // Starts watching only lazily, on the first /api/events connection (see
  // changes.ts) — creating the handle itself touches no filesystem, so no
  // rollback is needed if listen() below fails. Built before the manager
  // below because `agent-changed` (NOOP-230 §4.4) rides this same fan-out.
  const changeBroadcaster = createChangeBroadcaster(presentationId);
  disposers.push(() => changeBroadcaster.dispose());

  // NOOP-230: owns the agent's whole lifecycle (which kind is current, its
  // login status, the one live AgentChatSession, and swapping that session
  // out on POST /api/agent/select) — serve.ts no longer constructs
  // AgentChatSession directly. `initialAgent` (cli.ts's resolved
  // kind/source) wins when given; falling back to `agent` (see its own
  // docstring) keeps every existing direct-`agent` caller unchanged.
  const initialAgent: { kind: AgentKind | null; source: AgentSource } =
    options.initialAgent ?? (options.agent ? { kind: options.agent.kind, source: "cli" } : { kind: null, source: "none" });
  const fallbackAgent = options.agent;
  const resolveAdapter =
    options.agentManager?.resolveAdapter ??
    ((kind: AgentKind): AgentAdapterConfig =>
      fallbackAgent && kind === fallbackAgent.kind ? fallbackAgent : resolveAdapterConfig(kind));
  const manager = new AgentManager({
    presentationId,
    editingLock,
    workdir: agentWorkdir,
    initial: initialAgent,
    runCommand: options.agentManager?.runCommand,
    resolveAdapter,
    onAgentChanged: (payload) => changeBroadcaster.broadcast("agent-changed", payload),
    // Back-compat (see `agent`'s own docstring above and AgentManagerOptions.
    // assumeLoggedIn's docstring): a directly-given `agent` has no real
    // "logged in" concept to probe, so its kind is exempted from the real
    // probe rather than gated on whatever a real `claude`/`codex` CLI
    // happens to report on the host running the tests.
    assumeLoggedIn: fallbackAgent && !options.agentManager?.runCommand ? new Set([fallbackAgent.kind]) : undefined,
  });
  // Every SSE stream `/api/chat/stream` has ever opened, still connected.
  // `server.close()` waits for established connections rather than
  // closing them, and an SSE stream never ends on its own — so these must
  // be closed explicitly, before the socket itself is closed, or shutdown
  // hangs forever with a browser tab open.
  const chatStreams = createChatStreamRegistry();
  disposers.push(async () => {
    chatStreams.closeAll();
    await manager.dispose();
  });

  const onFrozen = () => changeBroadcaster.broadcast("editing-frozen", {});
  const onUnfrozen = () => changeBroadcaster.broadcast("editing-unfrozen", {});
  editingLock.on("frozen", onFrozen);
  editingLock.on("unfrozen", onUnfrozen);
  disposers.push(async () => {
    editingLock.off("frozen", onFrozen);
    editingLock.off("unfrozen", onUnfrozen);
  });

  // `/` 斜線命令清單（architecture comment on #232/#236): agent report ∪
  // bundled skills ∪ user skills, recomputed on demand rather than cached —
  // the underlying skill directories can change between calls and this is
  // never hot-path code. `GET /api/agent/commands` below calls this
  // directly for the initial value; the SSE push below recomputes and
  // re-broadcasts the same shape whenever the agent sends a fresh report.
  // Resolved lazily, on first actual use, rather than eagerly here: several
  // existing tests (e.g. raw.test.ts) build a `ServeOptions` with no
  // `agent` at all, because they never touch chat — startServe must not
  // crash on `options.agent.kind` for those callers just because this
  // unrelated feature also lives here.
  // Keyed by kind, not a single slot: the user skill directory differs per
  // agent (~/.claude/skills vs ~/.agents/skills), and POST /api/agent/select
  // can switch kinds while the server runs — a one-shot cache would keep
  // serving the directory of whichever agent happened to ask first.
  const skillDirsByKind = new Map<AgentKind, SkillDirs>();
  const computeSlashCommands = (): Promise<SlashCommand[]> => {
    const kind = manager.currentKind();
    // No agent selected yet: no agent report and no user skill directory to
    // point at, so the list is legitimately empty rather than an error.
    if (kind === null) return Promise.resolve([]);
    let dirs = skillDirsByKind.get(kind);
    if (!dirs) {
      dirs = resolveSkillDirs(kind, options.skillDirs);
      skillDirsByKind.set(kind, dirs);
    }
    return collectSlashCommands(manager.getReportedCommands(), dirs);
  };
  const detachCommands = manager.onAvailableCommands(() => {
    void computeSlashCommands().then((commands) => {
      changeBroadcaster.broadcast("agent-commands", { commands });
    });
  });
  disposers.push(async () => {
    detachCommands();
  });

  // NOOP-93 §4.4: one export job at a time, for this server's whole
  // lifetime — a fresh manager per `startServe` call, never persisted.
  // `serverAddress` starts with a placeholder port because the real one
  // (`actualPort`, below) is not known until `listen()` resolves, but the
  // object identity is fixed now so the request handler closure below can
  // read whatever it holds *at request time* — by then `listen()` has long
  // since resolved and the real value has been written into it.
  const exportJobManager = new ExportJobManager();
  const serverAddress = { host, port: 0 };

  const server = http.createServer((req, res) => {
    void handleRequest(
      registry,
      presentationId,
      staticDir,
      manager,
      chatStreams,
      changeBroadcaster,
      editingLock,
      exportJobManager,
      serverAddress,
      computeSlashCommands,
      req,
      res,
    );
  });

  await listen(server, port, host);
  const actualPort = (server.address() as AddressInfo).port;
  serverAddress.port = actualPort;

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
  manager: AgentManager,
  chatStreams: ChatStreamRegistry,
  changeBroadcaster: ChangeBroadcaster,
  editingLock: EditingLock,
  exportJobManager: ExportJobManager,
  serverAddress: { host: string; port: number },
  computeSlashCommands: () => Promise<SlashCommand[]>,
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
        await handleChatPost(manager, req, res);
        return;
      }
      if (url.pathname === "/api/agent/probe") {
        // NOOP-230 §4.4: same shape as GET /api/agent, but always reruns
        // both login probes rather than reading the cache (§7.7).
        const status = await manager.probe();
        sendJson(res, 200, status);
        return;
      }
      if (url.pathname === "/api/agent/select") {
        await handleAgentSelectPost(manager, req, res);
        return;
      }
      if (url.pathname === "/api/command") {
        // NOOP-91 §4.9: the front end's only write path. Whitelisting and
        // the server-owned presentation id both live inside the handler,
        // not here. The freeze gate (T5, NOOP-93/#110) DOES live here, at
        // the same call-site level as /api/undo and /api/redo below: agent
        // holding the floor refuses with 409, idle/human pass through
        // unchanged — this route never blocks the agent's own commands.
        if (editingLock.getState() === "agent") {
          sendJson(res, 409, { error: new EditingLockConflictError().message });
          return;
        }
        await handleCommandPost(registry, presentationId, req, res);
        return;
      }
      if (url.pathname === "/api/asset") {
        // T3/NOOP-142: the same "agent holds the floor" 409 gate as
        // /api/command, at the same call-site level — a Ribbon-driven
        // asset upload is a human write, not exempt from the single-editor
        // lock just because it does not go through registry.dispatch.
        if (editingLock.getState() === "agent") {
          sendJson(res, 409, { error: new EditingLockConflictError().message });
          return;
        }
        await handleAssetPost(presentationId, req, res);
        return;
      }
      if (url.pathname === "/api/open") {
        // NOOP-93 §4.1: the GUI's Open action is a human write like
        // /api/asset above — same "agent holds the floor" 409 gate, same
        // call-site level.
        if (editingLock.getState() === "agent") {
          sendJson(res, 409, { error: new EditingLockConflictError().message });
          return;
        }
        await handleOpenPost(presentationId, changeBroadcaster, req, res);
        return;
      }
      if (url.pathname === "/api/save") {
        if (editingLock.getState() === "agent") {
          sendJson(res, 409, { error: new EditingLockConflictError().message });
          return;
        }
        await handleSavePost(presentationId, changeBroadcaster, res);
        return;
      }
      if (url.pathname === "/api/export") {
        // NOOP-93 §4.4: deliberately NOT gated on editingLock — exporting
        // reads the presentation, it never writes to it, so it is not part
        // of the single-editor lock's "who may write right now" story
        // (unlike /api/open, /api/save, /api/command, and /api/asset
        // above). Do not "helpfully" add this gate later.
        await handleExportPost(exportJobManager, registry, presentationId, serverAddress, changeBroadcaster, req, res);
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

    if (url.pathname === "/api/agent") {
      // NOOP-230 §4.4: cached — never reprobes on its own (§7.7). Use
      // POST /api/agent/probe for a fresh read.
      const status = await manager.status();
      sendJson(res, 200, status);
      return;
    }

    if (url.pathname === "/api/editing") {
      sendJson(res, 200, { frozen: editingLock.getState() === "agent" });
      return;
    }

    if (url.pathname === "/api/agent/commands") {
      // Same "GET for the initial value, SSE for updates, no replay"
      // pattern as /api/editing above: a page load must see the current
      // list without waiting for the agent to happen to re-report it.
      const commands = await computeSlashCommands();
      sendJson(res, 200, { commands });
      return;
    }

    if (url.pathname === "/api/save-state") {
      // NOOP-93 §4.2: no-replay SSE (sse.ts) means the *initial* state on
      // load/reconnect must come from a plain GET, same pattern as
      // /api/editing above — never inferred from the last `save-state`
      // event, which a fresh page load never saw.
      const state = await readSaveState(presentationId);
      sendJson(res, 200, state);
      return;
    }

    if (url.pathname.startsWith("/api/export/") && url.pathname.endsWith("/file")) {
      const jobId = url.pathname.slice("/api/export/".length, -"/file".length);
      await handleExportFileGet(exportJobManager, jobId, res);
      return;
    }

    if (url.pathname === "/api/default-font") {
      // The one font every build ships (core's DEFAULT_FONT_FAMILY). The
      // browser needs its metrics to wrap a text box whose <text> declares
      // no font-family of its own — a legal SVG the presentation's own
      // `fonts` list says nothing about, so /api/raw/ cannot serve it.
      const bytes = readDefaultFontBytes();
      res.writeHead(200, { "content-type": "font/ttf", "content-length": String(bytes.byteLength) });
      res.end(bytes);
      return;
    }

    if (url.pathname === "/api/presentation") {
      await handlePresentationRoute(registry, presentationId, res);
      return;
    }

    if (url.pathname.startsWith("/api/files/")) {
      const virtualPath = decodeURIComponent(url.pathname.slice("/api/files/".length));
      await handleFilesRoute(registry, presentationId, virtualPath, res);
      return;
    }

    if (url.pathname.startsWith("/api/effects/")) {
      const virtualPath = decodeURIComponent(url.pathname.slice("/api/effects/".length));
      await handleEffectsRoute(registry, presentationId, virtualPath, res);
      return;
    }

    if (url.pathname === "/api/chat/stream") {
      chatStreams.open(manager, res);
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
      // The Range header is read here, at the one place that has `req`, and
      // handed on as a plain value: handleRawRoute stays a function of
      // (path, response, range) rather than growing a dependency on the
      // whole request object it has no other use for (ticket #13).
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

/**
 * `POST /api/chat` — accepts the author's message and returns immediately;
 * the reply is never awaited here, it streams separately over
 * `/api/chat/stream`.
 *
 * NOOP-230 §4.4: gated ahead of the existing JSON/empty-string validation —
 * no agent selected, or the selected one not logged in, is refused with a
 * 409 naming why (`reason: "unset" | "unauthenticated"`) before the body is
 * even parsed.
 */
async function handleChatPost(manager: AgentManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const status = await manager.status();
  if (status.current === null) {
    sendJson(res, 409, { error: "尚未選擇 agent，請先在設定中選擇要使用的 agent", reason: "unset", kind: null });
    return;
  }
  const card = status.agents.find((agent) => agent.kind === status.current)!;
  if (card.status === "unauthenticated") {
    sendJson(res, 409, {
      error: `${card.label} 尚未登入，請在終端機執行 ${card.loginCommand}`,
      reason: "unauthenticated",
      kind: status.current,
    });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "請求內容不是有效的 JSON" });
    return;
  }
  const text = (body as { text?: unknown } | null)?.text;
  // An empty message is allowed through: with comments pinned, "no text"
  // is a real request ("do what the pins say"), and only the session —
  // which reads the pins off disk a moment from now — can tell that case
  // apart from an empty message with nothing pinned to it. That one is
  // refused there, not here.
  if (typeof text !== "string") {
    sendJson(res, 400, { error: "訊息內容不可為空" });
    return;
  }
  manager.sendMessage(text);
  sendJson(res, 202, { ok: true });
}

/**
 * `POST /api/agent/select` (NOOP-230 §4.4). `kind` is the only accepted
 * body shape; `AgentManager.select` itself decides whether this is a same-
 * kind settings-only write or an actual session swap (see its own
 * docstring) — this handler only translates its outcome/errors to HTTP.
 */
async function handleAgentSelectPost(manager: AgentManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "請求內容不是有效的 JSON" });
    return;
  }
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (kind !== "claude" && kind !== "codex") {
    sendJson(res, 400, { error: "kind 必須是下列其中一個值：claude、codex" });
    return;
  }
  try {
    const status = await manager.select(kind);
    sendJson(res, 200, { ok: true, current: status.current, source: status.source });
  } catch (error) {
    if (error instanceof AgentSwitchLockedError) {
      sendJson(res, 409, { error: error.message, reason: "editing" });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "選擇 agent 失敗" });
  }
}

/**
 * `POST /api/save` (NOOP-93 §4.2). Always actually packs — "nothing to
 * save" is not special-cased into a skipped write, because a button that
 * silently does nothing on some clicks and not others is worse than one
 * that always does the same visible thing (§4.2's table, row 4).
 */
async function handleSavePost(
  presentationId: string,
  changeBroadcaster: ChangeBroadcaster,
  res: ServerResponse,
): Promise<void> {
  try {
    await savePresentation(presentationId);
  } catch (error) {
    if (error instanceof CoMotionInvalidRequestError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error instanceof CoMotionError ? error.message : "儲存失敗" });
    return;
  }
  sendJson(res, 200, { ok: true });
  await broadcastSaveState(changeBroadcaster, presentationId);
}

/**
 * `POST /api/export` (NOOP-93 §4.4). Starts a job through
 * `ExportJobManager.start()` — which is also the whole 409 gate: the
 * concurrency check and the start happen inside that one synchronous call,
 * so nothing can race between "is one already running" and "start one".
 * `run` (the closure passed in here) is where this route's own knowledge —
 * the registry, the presentation id, this server's own address for
 * `render.ts`'s Playwright to navigate to — meets `render.ts`'s generic
 * "drive one headless page, produce a PDF" job.
 */
async function handleExportPost(
  exportJobManager: ExportJobManager,
  registry: CommandRegistry,
  presentationId: string,
  serverAddress: { host: string; port: number },
  changeBroadcaster: ChangeBroadcaster,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "format 必須是 pdf 或 pdf-frames" });
    return;
  }
  const format = (body as { format?: unknown } | null)?.format;
  if (format !== "pdf" && format !== "pdf-frames") {
    sendJson(res, 400, { error: "format 必須是 pdf 或 pdf-frames" });
    return;
  }

  let jobId: string;
  try {
    jobId = exportJobManager.start(
      format,
      (event) => changeBroadcaster.broadcast("export", event),
      async (id: string, jobFormat: ExportFormat, onRunning, onProgress) => {
        const project = await loadProject(registry, presentationId);
        const fileName = exportFileName(project.name, jobFormat);
        const outputPath = path.join(resolveCoMotionHome(), "exports", id, fileName);
        const result = await renderExportPdf({
          serverUrl: `http://${serverAddress.host}:${serverAddress.port}`,
          format: jobFormat,
          outputPath,
          onRunning,
          onProgress,
        });
        return { pageCount: result.pageCount, fileName, filePath: outputPath };
      },
    );
  } catch {
    sendJson(res, 409, { error: "已有匯出工作進行中" });
    return;
  }
  sendJson(res, 202, { jobId });
}

/**
 * `GET /api/export/:jobId/file` (NOOP-93 §4.4). 404 covers both "no such
 * job" and "job exists but is not done yet" — `ExportJobManager.getFilePath`
 * already collapses that distinction (see its own comment), and the table
 * this route implements draws no distinction between them either.
 */
async function handleExportFileGet(exportJobManager: ExportJobManager, jobId: string, res: ServerResponse): Promise<void> {
  const filePath = exportJobManager.getFilePath(jobId);
  if (!filePath) {
    sendJson(res, 404, { error: "找不到匯出檔案" });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    sendJson(res, 404, { error: "找不到匯出檔案" });
    return;
  }
  const fileName = path.basename(filePath);
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Length": bytes.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  res.end(bytes);
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
     * Binds to the `AgentManager` facade, not a specific `AgentChatSession`
     * (NOOP-230 §4.5): switching agents via `POST /api/agent/select`
     * disposes the old session (which `removeAllListeners()`s) and builds a
     * fresh one — binding directly to a session instance would silently go
     * deaf on every already-open `/api/chat/stream` connection the moment
     * that happens. `AgentManager.attachStream` only rewires its own
     * internal subscription on a swap; this stream's registration here is
     * never touched.
     *
     * Throws once shutdown has started, rather than handing the client a
     * 200 that will never carry a single byte.
     */
    open(manager: AgentManager, res: ServerResponse): void {
      if (closing) {
        throw new CoMotionError("伺服器正在關閉");
      }
      const stream = openEventStream(res);
      streams.add(stream);
      const detach = manager.attachStream((event, data) => stream.send(event, data));
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
