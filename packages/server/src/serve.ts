// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRunnerRoute, runnerSessionAuthorized } from "./agent-runner-auth.js";
import { injectEditorBootstrap, type EditorBootstrap } from "./editor-bootstrap.js";
import { SlidraError, SlidraNotFoundError } from "./slidra/errors.js";
import { runJsonCommand } from "./slidra/command.js";
import { resolveSlidraHome } from "./slidra/home.js";
import type { AgentAdapterConfig } from "./agent/session.js";
import {
  collectSlashCommands,
  resolveSkillDirs,
  type SkillDirs,
  type SlashCommand,
} from "./agent/commands.js";
import { deployAgentWorkdir } from "./agent/workdir.js";
import { createSandboxRoot } from "./sandbox/sandbox-root.js";
import {
  createSandboxLauncher,
  setActiveLauncher,
} from "./sandbox/launcher.js";
import { setActivePolicy } from "./sandbox/policy.js";
import { deployShimWrapper } from "./sandbox/shim-wrapper.js";
import { createShimToken, setShimConfig } from "./sandbox/shim-config.js";
import { handleShimExec } from "./sandbox/shim-endpoint.js";
import type { WorkbenchPolicy } from "./policy/types.js";
import {
  AgentManager,
  AgentSwitchLockedError,
  type AgentSource,
} from "./agent/manager.js";
import {
  ADAPTER_SPECS,
  buildAdapterRegistry,
  isAgentKind,
  resolveAdapterConfig,
  type AdapterSpec,
  type AgentKind,
} from "./agent/adapters.js";
import { readAgentSettings } from "./agent/settings.js";
import type { CommandRunner } from "./agent/probe.js";
import { openEventStream, type EventStream } from "./sse.js";
import { createChangeBroadcaster, type ChangeBroadcaster } from "./runner-events.js";
import { EditingLock, EditingLockConflictError } from "./editing-lock.js";
import { loadProject } from "./slidra/reads.js";
import { ExportJobManager, type ExportFormat } from "./export/job.js";
import { renderExportPdf } from "./export/render.js";
import { exportFileName } from "./export/output-name.js";
import {
  createDeckSession,
  DeckSwitchConflictError,
  type DeckIdentity,
  type DeckSession,
} from "./deck-switch.js";
import {
  startDeckServer,
  forwardDeckServerGet,
  getDeckServerJson,
  postDeckServerJson,
  type DeckServerClient,
} from "./deck-server-client.js";

/**
 * `slidra serve` is a mode of the CLI, not a second backend (ADR-0002):
 * every read of presentation content spawns the real `slidra` binary
 * ([E4.T9]/F7 — `slidra/`), the exact same program one-shot
 * `slidra cat`/`ls` runs. This module never opens a presentation file
 * directly.
 */
export interface ServeOptions {
  /**
   * The workbench's policy (NOOP-617, `#399`) — the one object that decides
   * outbound network, how files enter, the MCP allow-list, and the
   * sandbox's read/write rules for every workbench this server process
   * opens. Required, with no runtime default (`#399` arch: "no module that
   * consumes policy may name an edition" — a default here would make this
   * module the second place, after `cli.ts`, that has an opinion about
   * which edition is running). `cli.ts` passes `openPolicy`; every test
   * passes it explicitly too, for the same reason.
   */
  policy: WorkbenchPolicy;
  /**
   * Opaque id of an already-opened presentation (see `slidra open`) to
   * start already bound to.
   *
   * NOOP-433: no longer required — "no deck open" is now a fully supported
   * startup state (every route answers coherently, see `deck-switch.ts`),
   * not a startup failure. Omitted means serve starts with no deck; one is
   * bound later via `POST /api/deck/switch`. The field itself keeps its
   * name and shape (never renamed, per NOOP-433 §7 decision 7) — every
   * existing test suite and `e2e/helpers/launch.ts` already construct one
   * this way and must keep working unchanged.
   */
  presentationId?: string;
  /**
   * Port to bind. Defaults to 5173. Tests must always pass 0 (let the OS
   * assign a free port) and read the actual port back from the result —
   * never hardcode a port, or concurrent test suites collide.
   */
  port?: number;
  host?: string;
  /**
   * Browser-facing credential for the agent-runner routes. The launcher
   * supplies this for split-service deployments; omitted keeps the direct
   * test harness and the transitional combined server backward compatible.
   */
  runnerSessionToken?: string;
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
  /** The models picked earlier per agent kind (cli.ts reads them from settings.json); omitted in tests. */
  initialModels?: Partial<Record<AgentKind, string>>;
  /**
   * Test-only injection seams for `AgentManager`'s login probe and adapter
   * resolution (`probe.ts`/`adapters.ts`). Production code (`cli.ts`) never
   * sets `runCommand`/`resolveAdapter` — real serve always probes the real
   * CLIs and resolves the real adapter packages from `node_modules`.
   */
  agentManager?: {
    runCommand?: CommandRunner;
    resolveAdapter?: (kind: AgentKind) => AgentAdapterConfig;
    /**
     * The effective adapter registry (E10.T6/#400 D4) — every bundled kind
     * plus every user-declared one. Given at all (`cli.ts` always gives
     * one, built from `readAgentSettings()`), it wins outright. Omitted
     * (every existing test, and any caller — e.g. `e2e/helpers/launch.ts`
     * — that starts a server directly rather than through `cli.ts`) means
     * this function reads `<SLIDRA_HOME>/settings.json` itself the same
     * resilient way `cli.ts` does: a broken file never prevents serve from
     * starting, it just falls back to built-ins only.
     */
    adapters?: readonly AdapterSpec[];
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
  /** This server's own sandbox root (NOOP-425 D4) — where the agent's deployed work directory (and, once write isolation is active, the shim wrapper) lives. Never under `SLIDRA_HOME` any more. */
  agentSandboxRoot: string;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 5173;
const DEFAULT_HOST = "127.0.0.1";

/**
 * Validates the presentation and starts the HTTP server. Validation
 * (unknown id) happens before the socket is ever bound, so a bad startup
 * fails loudly without a half-started server left behind. A presentation
 * with no slides is valid (`new` creates none) — the editor
 * shows "No slides now" and the first page is made from there.
 */
export async function startServe(
  options: ServeOptions,
): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  // NOOP-433: the startup path never goes through `DeckSession.bind` —
  // deliberately, to keep this diff the smallest it can be (NOOP-433 §3's
  // own note): when a presentationId is given, this is exactly the
  // pre-NOOP-433 startup sequence, just wrapped in "only when given".
  let initialDeck: DeckIdentity | null = null;
  let initialWorkdir: string | null = null;

  const staticDir = options.staticDir ?? resolveWebDist();

  // Resources started alongside the HTTP server. close() tears them down in
  // registration order, before the socket itself is closed.
  const disposers: Array<() => Promise<void>> = [];
  let listeningServer: http.Server | undefined;

  try {
    // NOOP-425 D4: this serve process's own scratch tree for the agent's
    // deployed work directory — created unconditionally (even with no deck
    // bound yet) since a later deck switch's `bind` needs it too. Disposed
    // wholesale on shutdown, and one presentation at a time on `unbind`
    // below (AC9).
    const sandboxRoot = await createSandboxRoot();
    disposers.push(() => sandboxRoot.disposeAll());

    // NOOP-425 D5: the CLI-sandbox shim wrapper every spawned agent's PATH is
    // pointed at (`agent/manager.ts`'s `buildSession()`) — deployed once per
    // sandbox root, alongside it, since every presentation shares this one
    // `bin/` directory.
    await deployShimWrapper(sandboxRoot.path);
    const shimToken = createShimToken();

    // NOOP-425: this process's one active write-isolation launcher
    // (`getActiveLauncher()`, read by `agent/session.ts`'s spawn wrapping and
    // `agent/manager.ts`'s `writeIsolation` status) — never fails startup
    // itself (D8): platform/dependency/self-check failures all come back as
    // an inert, `active: false` launcher instead of throwing.
    const sandboxLauncher = await createSandboxLauncher();
    setActiveLauncher(sandboxLauncher);
    disposers.push(async () => {
      setActiveLauncher(undefined);
      await sandboxLauncher.dispose();
    });

    // NOOP-617: this process's one active policy — `buildCliSandboxPolicy`
    // (`sandbox/policy.ts`, called from `shim-endpoint.ts`) reads it back,
    // the same module-singleton shape `setActiveLauncher` above uses and for
    // the same reason (that call site may only be touched minimally).
    setActivePolicy(options.policy);
    disposers.push(() => {
      setActivePolicy(undefined);
      return Promise.resolve();
    });

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
    const changeBroadcaster = createChangeBroadcaster();
    disposers.push(() => changeBroadcaster.dispose());

    // NOOP-93 §4.4: one export job at a time, for this server's whole
    // lifetime — a fresh manager per `startServe` call, never persisted.
    // `serverAddress` starts with a placeholder port because the real one
    // (`actualPort`, below) is not known until `listen()` resolves, but the
    // object identity is fixed now so the request handler closure below can
    // read whatever it holds *at request time* — by then `listen()` has long
    // since resolved and the real value has been written into it.
    const exportJobManager = new ExportJobManager();
    const serverAddress = { host, port: 0 };

    // The HTTP server is created and `listen()`ed *before* `AgentManager`
    // below, and the closure here references `manager`/`chatStreams`/
    // `deckSession`/`computeSlashCommands` before any of them are
    // constructed — safe, because none of it runs until an actual request
    // arrives, which cannot happen before `startServe()` itself returns.
    // NOOP-425 D5/D6: this ordering is deliberate, not incidental —
    // `setShimConfig()` right after `listen()` needs the real port, and it
    // must be in place *before* `AgentManager`'s constructor builds its
    // first session (including a pre-selected `initialAgent`, the common
    // case on every normal startup) — otherwise that first session's spawn
    // env would permanently miss the shim token, silently disabling the CLI
    // sandbox for as long as that session lives (reproduced while writing
    // this: it manifested as every agent-issued `slidra` command hanging,
    // resolved to a shim with no server to answer it — see
    // packages/server/test/agent/fixtures/multi-command-fake-acp-agent.mjs's
    // real `slidra` invocations, which is what caught it).
    // Assigned immediately after this listener receives its real port. The
    // request closure cannot run through a public URL before startServe
    // returns, so every reachable request observes the initialized client.
    let deckServer: DeckServerClient;
    const server = http.createServer((req, res) => {
      void handleRequest(
        deckSession,
        staticDir,
        manager,
        chatStreams,
        changeBroadcaster,
        editingLock,
        exportJobManager,
        serverAddress,
        computeSlashCommands,
        sandboxRoot.path,
        shimToken,
        deckServer,
        options.runnerSessionToken,
        req,
        res,
      );
    });

    await listen(server, port, host);
    listeningServer = server;
    const actualPort = (server.address() as AddressInfo).port;
    serverAddress.port = actualPort;

    // The browser calls the crate directly, so its CORS allow-list needs the
    // runner's exact, now-known origin. Starting it before listen() produced
    // an unusable origin and forced the bootstrap back through Node.
    const combinedOrigin = `http://${host}:${actualPort}`;
    deckServer = await startDeckServer({ editorOrigin: combinedOrigin, fileEntry: options.policy.fileEntry });
    disposers.push(() => deckServer.close());

    if (options.presentationId !== undefined) {
      initialDeck = await resolveDeckIdentity(deckServer, options.presentationId);
      initialWorkdir = await deployAgentWorkdir(
        sandboxRoot.path,
        options.presentationId,
        options.policy,
      );
    }

    setShimConfig({
      token: shimToken,
      baseUrl: `http://${host}:${actualPort}`,
    });
    disposers.push(() => {
      setShimConfig(undefined);
      return Promise.resolve();
    });

    // NOOP-230: owns the agent's whole lifecycle (which kind is current, its
    // login status, the one live AgentChatSession, and swapping that session
    // out on POST /api/agent/select) — serve.ts no longer constructs
    // AgentChatSession directly. `initialAgent` (cli.ts's resolved
    // kind/source) wins when given; falling back to `agent` (see its own
    // docstring) keeps every existing direct-`agent` caller unchanged.
    const initialAgent: { kind: AgentKind | null; source: AgentSource } =
      options.initialAgent ??
      (options.agent
        ? { kind: options.agent.kind, source: "cli" }
        : { kind: null, source: "none" });
    const fallbackAgent = options.agent;
    // E10.T6/#400 D4: the effective adapter registry. `cli.ts` always passes
    // one (built from the same `readAgentSettings()` call it already makes
    // for `agent`/`models`); every other caller — every existing test, and
    // any caller (e.g. `e2e/helpers/launch.ts`) that starts a server directly
    // — gets it read here instead, the same resilient way (a broken
    // settings.json never prevents serve from starting, it just falls back
    // to built-ins only).
    let adapters = options.agentManager?.adapters;
    if (!adapters) {
      try {
        adapters = buildAdapterRegistry((await readAgentSettings()).adapters);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        adapters = ADAPTER_SPECS;
      }
    }
    // Back-compat (see `agent`'s own docstring): a directly-given `agent`
    // (every pre-NOOP-230 test suite, `e2e/helpers/launch.ts`) names a kind
    // that may not appear in any registry built above — `AgentManager` must
    // still be able to report a card for it (`status()`/`probe()` iterate the
    // registry, and `POST /api/chat`'s pre-gate looks its `current` kind up
    // in exactly that list), or the very first request throws reaching into
    // a card that was never there.
    if (
      fallbackAgent &&
      !adapters.some((spec) => spec.kind === fallbackAgent.kind)
    ) {
      adapters = [
        ...adapters,
        {
          kind: fallbackAgent.kind,
          label: fallbackAgent.label,
          writeRules: [],
        },
      ];
    }
    const resolveAdapter =
      options.agentManager?.resolveAdapter ??
      ((kind: AgentKind): AgentAdapterConfig =>
        fallbackAgent && kind === fallbackAgent.kind
          ? fallbackAgent
          : resolveAdapterConfig(kind, adapters));
    const manager = new AgentManager({
      presentationId: initialDeck?.id ?? null,
      editingLock,
      deckServer,
      policy: options.policy,
      workdir: initialWorkdir,
      initial: initialAgent,
      runCommand: options.agentManager?.runCommand,
      resolveAdapter,
      adapters,
      onAgentChanged: (payload) =>
        changeBroadcaster.broadcast("agent-changed", payload),
      onModelChanged: (payload) =>
        changeBroadcaster.broadcast("agent-model-changed", payload),
      initialModels: options.initialModels,
      // Back-compat (see `agent`'s own docstring above and AgentManagerOptions.
      // assumeLoggedIn's docstring): a directly-given `agent` has no real
      // "logged in" concept to probe, so its kind is exempted from the real
      // probe rather than gated on whatever a real `claude`/`codex` CLI
      // happens to report on the host running the tests.
      assumeLoggedIn:
        fallbackAgent && !options.agentManager?.runCommand
          ? new Set([fallbackAgent.kind])
          : undefined,
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
    const onUnfrozen = () => {
      changeBroadcaster.broadcast("editing-unfrozen", {});
    };
    editingLock.on("frozen", onFrozen);
    editingLock.on("unfrozen", onUnfrozen);
    disposers.push(async () => {
      editingLock.off("frozen", onFrozen);
      editingLock.off("unfrozen", onUnfrozen);
    });

    // The `/` slash-command list: agent report ∪ bundled skills ∪ user
    // skills, recomputed on demand rather than cached —
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

    // NOOP-433: owns the currently-bound deck's identity and the switch
    // sequence (`deck-switch.ts`'s own docstring has the fixed order). `bind`/
    // `unbind` are exactly `startServe`'s own startup wiring above, replayed
    // per switch — `deployAgentWorkdir` → `manager.retarget` → the
    // broadcaster's `retarget` for `bind`; the broadcaster first, then the
    // manager, for `unbind` (NOOP-433 §3).
    const deckSession = createDeckSession({
      initial: initialDeck,
      resolveDeck: (id) => resolveDeckIdentity(deckServer, id),
      guard: () => deckMutationGuard(editingLock, exportJobManager),
      unbind: async (outgoing) => {
        await changeBroadcaster.retarget(null);
        await manager.retarget(null);
        // AC9, "switching decks": the outgoing deck's agent working files
        // never persist inside the sandbox past the switch.
        await sandboxRoot.disposePresentation(outgoing.id);
      },
      bind: async (incoming) => {
        const workdir = await deployAgentWorkdir(
          sandboxRoot.path,
          incoming.id,
          options.policy,
        );
        await manager.retarget({ id: incoming.id, workdir });
        await changeBroadcaster.retarget(incoming.id);
      },
    });

    return {
      port: actualPort,
      url: `http://${host}:${actualPort}`,
      agentSandboxRoot: sandboxRoot.path,
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
  } catch (error) {
    // Startup can fail after the crate server is running (for example an
    // unknown deck or a busy port). Release every resource before rejecting.
    const failures: unknown[] = [];
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (listeningServer?.listening) {
      await new Promise<void>((resolve) => listeningServer!.close(() => resolve()));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        `Server startup failed: ${String(error)}`,
      );
    }
    throw error;
  }
}

/** Resolve opaque deck metadata exclusively through crate-owned APIs. */
async function resolveDeckIdentity(
  deckServer: DeckServerClient,
  id: string,
): Promise<DeckIdentity> {
  const [project, decks] = await Promise.all([
    getDeckServerJson(deckServer, "/presentation", id, "editor"),
    getDeckServerJson(
      deckServer,
      "/decks?owner=Anonymous",
      DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
      "editor",
    ),
  ]);
  if (project.status === 404) {
    throw new SlidraNotFoundError(`no presentation found for id: ${id}`);
  }
  if (project.status !== 200 || typeof project.body !== "object" || project.body === null) {
    throw new SlidraError("Failed to resolve deck metadata");
  }
  const entries = (decks.body as { decks?: unknown } | null)?.decks;
  const match = Array.isArray(entries)
    ? entries.find((entry) => (entry as { id?: unknown } | null)?.id === id)
    : undefined;
  const fileName = (match as { fileName?: unknown } | undefined)?.fileName;
  const name = (project.body as { name?: unknown }).name;
  return {
    id,
    name: typeof name === "string" ? name : null,
    fileName: typeof fileName === "string" ? fileName : null,
  };
}

/** `DeckIdentity` is already safe opaque metadata; no real path exists here. */
function toPublicDeck(deck: DeckIdentity): {
  id: string;
  name: string | null;
  fileName: string | null;
} {
  return {
    id: deck.id,
    name: deck.name,
    fileName: deck.fileName,
  };
}

function listen(
  server: http.Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") {
        // Never fall back to another port — a user who asked for a specific
        // port and silently got another has been lied to.
        reject(new SlidraError(`Port already in use: ${port}`));
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
  deckSession: DeckSession,
  staticDir: string,
  manager: AgentManager,
  chatStreams: ChatStreamRegistry,
  changeBroadcaster: ChangeBroadcaster,
  editingLock: EditingLock,
  exportJobManager: ExportJobManager,
  serverAddress: { host: string; port: number },
  computeSlashCommands: () => Promise<SlashCommand[]>,
  sandboxRootPath: string,
  shimToken: string,
  deckServer: DeckServerClient,
  runnerSessionToken: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    // ADR-0007: play mode gives the (untrusted, ADR-0011) slide's iframe
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
    if (
      req.headers.origin === "null" &&
      !(req.url ?? "").startsWith("/api/raw/")
    ) {
      sendJson(res, 403, {
        error: "Does not accept requests from an opaque origin (Origin: null)",
      });
      return;
    }

    // Parsed before the method gate so POST /api/chat can be routed
    // explicitly — every other POST still gets the same 405 it always did.
    const url = new URL(req.url ?? "/", "http://localhost");

    if (
      runnerSessionToken !== undefined &&
      isRunnerRoute(url.pathname) &&
      !runnerSessionAuthorized(req.headers, runnerSessionToken)
    ) {
      sendJson(res, 401, { error: "Invalid runner session" });
      return;
    }

    if (req.method === "POST") {
      if (url.pathname === "/api/chat") {
        // NOOP-433 §4's table: no-deck is checked here, before the existing
        // unset/unauthenticated gate below — a kind can be selected with no
        // deck open (AgentManager builds no session either way), and
        // without this check that would fall through to `sendMessage`'s own
        // "No agent selected" error, which is simply the wrong reason.
        if (deckSession.currentId() === null) {
          sendJson(res, 409, { error: "No deck is open", reason: "no-deck" });
          return;
        }
        await handleChatPost(manager, req, res);
        return;
      }
      if (url.pathname === "/api/chat/cancel") {
        await handleChatCancelPost(manager, res);
        return;
      }
      if (url.pathname === "/api/chat/new") {
        await handleChatNewPost(manager, res);
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
      if (url.pathname === "/api/agent/model") {
        await handleAgentModelPost(manager, req, res);
        return;
      }
      if (url.pathname === "/api/agent/session") {
        // The chat panel's "Choose model…": brings the ACP session up before
        // the first message so the model list exists to pick from. Same
        // handshake the first message would run; no author turn happens.
        try {
          sendJson(res, 200, await manager.warmSession());
        } catch (error) {
          if (error instanceof SlidraError) {
            sendJson(res, 409, { error: error.message });
            return;
          }
          sendJson(res, 500, {
            error:
              error instanceof Error
                ? error.message
                : "Failed to create conversation",
          });
        }
        return;
      }
      if (url.pathname === "/api/deck/switch") {
        // NOOP-433: never gated on `requireDeck` below — switching is the
        // one write route that must work with no deck open (entering a
        // deck for the first time) as well as with one already open.
        await handleDeckSwitchPost(
          deckSession,
          req,
          res,
        );
        return;
      }
      if (url.pathname === "/api/new") {
        // [E6.T2]: deck-independent (never gated on `requireDeck`/the
        // editing-lock below) — creates a new deck in the deck folder, does
        // not switch to it and does not touch whichever deck this server
        // currently has open, if any.
        await handleNewForward(deckServer, req, res);
        return;
      }
      if (url.pathname === "/api/open") {
        // [E6.T2]: same "deck-independent" contract as /api/new above.
        await handleOpenForward(deckServer, req, res);
        return;
      }
      if (url.pathname === "/api/deck/import") {
        await handleDeckImportForward(deckServer, req, res);
        return;
      }
      if (url.pathname === "/api/deck/rename") {
        await handleDeckRenameForward(deckSession, deckServer, req, res);
        return;
      }
      if (url.pathname === "/api/deck/rename-current") {
        // The title bar's own rename — the one case `/api/deck/rename`
        // refuses (the deck this server currently has bound). Never gated
        // on `requireDeck`/the editing-lock check below: it has its own
        // no-deck/editing/exporting guards, matching `/api/deck/switch`.
        await handleRenameCurrentPost(
          deckSession,
          deckServer,
          changeBroadcaster,
          editingLock,
          exportJobManager,
          req,
          res,
        );
        return;
      }
      if (url.pathname === "/api/deck/delete") {
        await handleDeckDeleteForward(deckSession, deckServer, req, res);
        return;
      }
      if (url.pathname === "/api/deck/resolve") {
        // [E6.T4]: deck-independent, like /api/new and /api/open above —
        // lazily registers a deck folder entry Deck Space's list never
        // minted an id for.
        await handleDeckResolveForward(deckServer, req, res);
        return;
      }
      if (url.pathname === "/api/agent/exec") {
        // NOOP-425 D5/D6: the CLI sandbox's own entry point — only
        // `<sandboxRoot>/bin/slidra` (the shim wrapper) ever calls this,
        // authenticated by a per-serve token rather than by origin (a
        // subprocess has no Origin header at all). See `shim-endpoint.ts`'s
        // own docstring for the byte-framed streaming protocol.
        handleShimExec(req, res, {
          sandboxRoot: sandboxRootPath,
          token: shimToken,
          currentDeckId: () => deckSession.currentId(),
        });
        return;
      }
      if (url.pathname === "/api/export") {
        // NOOP-93 §4.4: deliberately NOT gated on editingLock — exporting
        // reads the presentation, it never writes to it, so it is not part
        // of the single-editor lock's "who may write right now" story
        // (unlike /api/open, /api/save, /api/command, and /api/asset
        // above). Do not "helpfully" add this gate later.
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        await handleExportPost(
          exportJobManager,
          deckId,
          serverAddress,
          changeBroadcaster,
          req,
          res,
        );
        return;
      }
      if (url.pathname === "/api/editing/begin") {
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        await handleEditingBeginPost(deckServer, deckId, editingLock, res);
        return;
      }
      if (url.pathname === "/api/editing/end") {
        // "crate decides first, Node applies": `endHumanEdit()` never
        // refuses (a no-op when not `human`, per its own doc comment), so
        // there is no status to branch on here — the crate's `POST
        // /editing/end` is called for the mirror, then the local object's
        // existing event plumbing fires exactly as before.
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        await postDeckServerJson(deckServer, "/editing/end", deckId, "editor");
        editingLock.endHumanEdit();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/identity/sign-in") {
        await handleIdentitySignInForward(deckServer, req, res);
        return;
      }
      if (url.pathname === "/api/identity/sign-out") {
        await handleIdentitySignOutForward(deckServer, res);
        return;
      }
      sendJson(res, 405, { error: "Only GET is supported" });
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Only GET is supported" });
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

    if (url.pathname === "/api/deck") {
      // NOOP-433: the one way a page (re)load learns which deck, if any, is
      // currently open — there is no other route this can be inferred from.
      const deck = deckSession.current();
      sendJson(res, 200, { deck: deck ? toPublicDeck(deck) : null });
      return;
    }

    if (url.pathname === "/api/decks") {
      // [E6.T2]: deck-independent, like /api/new and /api/open above —
      // scans the deck folder directly, regardless of whether this server
      // currently has a deck open. [E6.T9]: with no ?owner= given, the
      // crate's own route applies identity's visibility filter itself
      // (`identity::visible_decks()`) — Node forwards the query string
      // as-is and never resolves this locally any more.
      await forwardDeckServerGet(
        deckServer,
        `/decks${url.search}`,
        DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
        res,
      );
      return;
    }

    if (url.pathname === "/api/identity") {
      // [E6.T9] AC1: the user block's initial render — current identity
      // (null when anonymous) plus every registered provider.
      await forwardDeckServerGet(
        deckServer,
        "/identity",
        DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
        res,
      );
      return;
    }

    if (url.pathname === "/api/decks/thumbnail") {
      // [E6.T4]: deck-independent, same contract as /api/decks above.
      // `If-None-Match` is forwarded as-is; the crate's own ETag/304
      // handling does the rest, same as every other forwarded GET route.
      const extraHeaders: Record<string, string> = {};
      const ifNoneMatch = req.headers["if-none-match"];
      if (typeof ifNoneMatch === "string")
        extraHeaders["if-none-match"] = ifNoneMatch;
      await forwardDeckServerGet(
        deckServer,
        `/decks/thumbnail${url.search}`,
        DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
        res,
        extraHeaders,
      );
      return;
    }

    if (
      url.pathname.startsWith("/api/export/") &&
      url.pathname.endsWith("/file")
    ) {
      const jobId = url.pathname.slice("/api/export/".length, -"/file".length);
      await handleExportFileGet(exportJobManager, jobId, res);
      return;
    }

    if (url.pathname === "/api/default-font") {
      // The one font every build ships (core's DEFAULT_FONT_FAMILY). The
      // browser needs its metrics to wrap a text box whose <text> declares
      // no font-family of its own — a legal SVG the presentation's own
      // `fonts` list says nothing about, so /api/raw/ cannot serve it.
      const bytes = await readFile(resolveDefaultFontPath());
      res.writeHead(200, {
        "content-type": "font/ttf",
        "content-length": String(bytes.byteLength),
      });
      res.end(bytes);
      return;
    }

    if (url.pathname === "/api/presentation") {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      await forwardDeckServerGet(deckServer, "/presentation", deckId, res);
      return;
    }

    if (url.pathname === "/api/assets") {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      await forwardDeckServerGet(deckServer, "/assets", deckId, res);
      return;
    }

    if (url.pathname.startsWith("/api/files/")) {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      // The still-percent-encoded segment is forwarded as-is — the crate's
      // own `reads::handle_files` decodes it and answers 400 on a malformed
      // escape, so this layer never needs its own `decodeURIComponent`/
      // try-catch pair.
      const encodedPath = url.pathname.slice("/api/files/".length);
      await forwardDeckServerGet(
        deckServer,
        `/files/${encodedPath}`,
        deckId,
        res,
      );
      return;
    }

    if (url.pathname.startsWith("/api/effects/")) {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      const encodedPath = url.pathname.slice("/api/effects/".length);
      await forwardDeckServerGet(
        deckServer,
        `/effects/${encodedPath}`,
        deckId,
        res,
      );
      return;
    }

    if (url.pathname === "/api/chat/stream") {
      chatStreams.open(manager, res);
      return;
    }

    if (url.pathname === "/api/chat/history") {
      // AC1/AC2: what a page (re)load or a reopened deck restores the
      // thread from — the live SSE stream carries no replay, so this is the
      // only way either of those sees anything that happened before this
      // connection existed.
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      await handleChatHistoryGet(deckId, url.searchParams, res);
      return;
    }

    if (url.pathname === "/api/events") {
      // Live reload push (ticket #5): opens a long-lived SSE stream. Never
      // returns/closes `res` itself — handleConnection hands it to
      // openEventStream, which owns the response from here on.
      //
      // This stays Node's own multiplexing broadcaster ([E10.T5] does NOT
      // forward this route wholesale to the crate, unlike the five GET
      // routes above): one browser tab's single `/api/events` connection
      // carries several unrelated event kinds (`presentation-changed`,
      // `agent-changed`, `editing-frozen`/`unfrozen`, `save-state`,
      // `deck-changed`), and only the first of those is this ticket's
      // concern. What DID move into the crate is the underlying watch
      // itself: `watch.ts` now sources `presentation-changed` from the
      // crate's own `GET /events` instead of a local `fs.watch` — see that
      // module's own doc comment.
      await changeBroadcaster.handleConnection(res);
      return;
    }

    if (url.pathname.startsWith("/api/raw/")) {
      // Deliberately NOT `POST /api/command`'s whitelist, unlike every
      // other read in this file. Every whitelisted command is reachable by
      // the agent (ADR-0003's permission hook allows `slidra *`). A
      // byte-preserving read registered as a command would hand the agent
      // the exact capability ticket #2 closed off — dozens of MB of raw
      // video/image bytes dumped into its context. Browsers, not agents,
      // need this route.
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      const encodedPath = url.pathname.slice("/api/raw/".length);
      const extraHeaders: Record<string, string> = {};
      if (req.headers.range !== undefined)
        extraHeaders.range = req.headers.range;
      // ADR-0006: the sandboxed srcdoc iframe's own slide markup fetches
      // `@font-face` sources cross-origin from an opaque origin — this
      // route is the one exemption from the Origin: null gate above, and
      // it must say so on every response, not just success, or the font
      // fetch itself is what the browser blocks.
      res.setHeader("Access-Control-Allow-Origin", "*");
      await forwardDeckServerGet(
        deckServer,
        `/raw/${encodedPath}`,
        deckId,
        res,
        extraHeaders,
      );
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "Endpoint not found" });
      return;
    }

    if (url.pathname === "/") {
      const requestedWorkbench = url.searchParams.get("workbench");
      if (requestedWorkbench !== null && requestedWorkbench !== deckSession.currentId()) {
        await deckSession.switchTo(requestedWorkbench);
      }
    }

    const combinedOrigin = `http://${serverAddress.host}:${serverAddress.port}`;
    await serveStatic(staticDir, url.pathname, res, {
      workbenchId: deckSession.currentId(),
      deck: {
        url: deckServer.baseUrl,
        credential: Buffer.from(
          JSON.stringify({ kind: "editor", workbenchId: deckSession.currentId() ?? "deck-space" }),
          "utf8",
        ).toString("base64"),
      },
      agentRunner: {
        url: combinedOrigin,
        sessionToken: runnerSessionToken ?? "legacy-combined-server",
      },
    });
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * NOOP-433 §4's table: every deck-scoped route 409s with `reason: "no-deck"`
 * while no deck is bound, checked ahead of every other guard that route
 * already had (editing-lock included). Writes the response and returns
 * null when there is no deck to hand back; a route handler's job is then
 * just `if (deckId === null) return;`.
 */
/**
 * Shared by `deckSession`'s own switch guard (`createDeckSession`'s `guard`
 * option) and `handleRenameCurrentPost` — renaming the bound deck's file is
 * only safe under the exact same conditions a switch away from it is.
 */
function deckMutationGuard(
  editingLock: EditingLock,
  exportJobManager: ExportJobManager,
): { reason: string; message: string } | null {
  if (editingLock.getState() !== "idle") {
    return { reason: "editing", message: new AgentSwitchLockedError().message };
  }
  if (exportJobManager.hasActiveJob()) {
    return {
      reason: "exporting",
      message: "An export job is already in progress",
    };
  }
  return null;
}

function requireDeck(
  deckSession: DeckSession,
  res: ServerResponse,
): string | null {
  const id = deckSession.currentId();
  if (id === null) {
    sendJson(res, 409, { error: "No deck is open", reason: "no-deck" });
    return null;
  }
  return id;
}

/**
 * `POST /api/deck/switch` (NOOP-433) — body `{ id: string }`. Body
 * validation happens here, before `DeckSession.switchTo` is ever called;
 * every other outcome (conflict, unknown id, a `bind` failure) is
 * `switchTo`'s own to throw and this route's own to translate to HTTP
 * (§4's table). The `deck-changed`/`presentation-changed`
 * broadcast only fires when a switch actually happened — the same-id
 * short-circuit rebuilds nothing, so there is nothing to announce.
 */
async function handleDeckSwitchPost(
  deckSession: DeckSession,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "") {
    sendJson(res, 400, { error: "id must be a non-empty string" });
    return;
  }

  let result: { deck: DeckIdentity; switched: boolean };
  try {
    result = await deckSession.switchTo(id);
  } catch (error) {
    if (error instanceof DeckSwitchConflictError) {
      sendJson(res, 409, { error: error.message, reason: error.reason });
      return;
    }
    if (error instanceof SlidraNotFoundError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Failed to switch deck",
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    switched: result.switched,
    deck: toPublicDeck(result.deck),
  });
}

/**
 * `POST /api/deck/rename-current` — the title bar's inline rename. Body:
 * `{ name: string }`; the deck to rename is always whichever one
 * `deckSession` currently has bound (there is no `id` in the body). Refuses
 * with the same `{reason:"editing"}`/`{reason:"exporting"}` conflicts a
 * switch would (`guard`), and with `{reason:"no-deck"}` when nothing is
 * open. On success, renames the file (forwarded to the crate's
 * `POST /deck/rename` —
 * unguarded there, exactly like the old, now-deleted `DeckStore.renameBound`
 * this replaces), then re-points the file watcher at the new path
 * (`changeBroadcaster.retarget`) — `retarget` always tears down and rebuilds
 * the watcher, even for the same id, so this is enough to make live reload
 * see the renamed file.
 */
async function handleRenameCurrentPost(
  deckSession: DeckSession,
  deckServer: DeckServerClient,
  changeBroadcaster: ChangeBroadcaster,
  editingLock: EditingLock,
  exportJobManager: ExportJobManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const id = requireDeck(deckSession, res);
  if (id === null) return;

  const conflict = deckMutationGuard(editingLock, exportJobManager);
  if (conflict) {
    sendJson(res, 409, { error: conflict.message, reason: conflict.reason });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const name = (body as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || name === "") {
    sendJson(res, 400, { error: "name must be a non-empty string" });
    return;
  }

  const forwardBody = Buffer.from(JSON.stringify({ id, name }), "utf8");
  const upstream = await postDeckServerJson(
    deckServer,
    "/deck/rename",
    DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
    "editor",
    {
      body: forwardBody,
    },
  );
  if (upstream.status !== 200) {
    // The crate's own error shapes already match what this route used to
    // throw directly: 409 `{error, reason:"name-conflict"}`, 404 `{error}`.
    sendJson(res, upstream.status, upstream.body);
    return;
  }
  const fileName = (upstream.body as { fileName?: unknown } | null)?.fileName;
  if (typeof fileName !== "string") {
    sendJson(res, 500, { error: "deck server returned no fileName" });
    return;
  }

  // `deckSession.current()` otherwise keeps reporting the pre-rename metadata.
  await deckSession.refreshCurrent({ fileName });
  await changeBroadcaster.retarget(id);
  sendJson(res, 200, { ok: true, fileName });
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
async function handleChatPost(
  manager: AgentManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const status = await manager.status();
  if (status.current === null) {
    sendJson(res, 409, {
      error: "No agent selected, choose one in settings first",
      reason: "unset",
      kind: null,
    });
    return;
  }
  const card = status.agents.find((agent) => agent.kind === status.current)!;
  if (card.status === "unauthenticated") {
    sendJson(res, 409, {
      error: `${card.label} is not logged in, run ${card.loginCommand} in a terminal`,
      reason: "unauthenticated",
      kind: status.current,
    });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const text = (body as { text?: unknown } | null)?.text;
  // An empty message is allowed through: with comments pinned, "no text"
  // is a real request ("do what the pins say"), and only the session —
  // which reads the pins off disk a moment from now — can tell that case
  // apart from an empty message with nothing pinned to it. That one is
  // refused there, not here.
  if (typeof text !== "string") {
    sendJson(res, 400, { error: "Message content must not be empty" });
    return;
  }
  // Optional: what the author's message looks like in the persisted/
  // restored conversation, when it differs from what was actually sent to
  // the agent (e.g. the "(No message entered...)" placeholder for a
  // pins-only send) — §7 decision 8.
  const rawDisplayText = (body as { displayText?: unknown } | null)
    ?.displayText;
  const displayText =
    typeof rawDisplayText === "string" ? rawDisplayText : undefined;
  // #303: one line per author message so a turn that starts unexpectedly
  // (e.g. right after a cancel) can be traced to the request that caused it.
  console.log(
    `[chat] ${new Date().toISOString()} message ${JSON.stringify(text.slice(0, 60))}${text.length > 60 ? "…" : ""}`,
  );
  manager.sendMessage(text, displayText);
  sendJson(res, 202, { ok: true });
}

/**
 * `GET /api/chat/history?limit=&query=` — reads the conversation persisted
 * in the open deck's own `chat_history` table (`slidra chat-history`).
 * `limit`/`query` are passed straight through to the CLI, which owns their
 * validation (an out-of-range `limit`, or an empty `query`, comes back as
 * `ok:false` — reported here as 400, everything else this call could fail
 * on is a 500). Both are optional; omitted, the CLI's own default
 * (20, unfiltered) applies.
 */
async function handleChatHistoryGet(
  deckId: string,
  searchParams: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const args = ["chat-history", deckId];
  const limit = searchParams.get("limit");
  if (limit !== null) args.push("--limit", limit);
  const query = searchParams.get("query");
  if (query !== null) args.push("--query", query);

  const result = await runJsonCommand<{
    entries: unknown[];
    total: number;
    truncated: boolean;
  }>(args);
  if (!result.ok) {
    sendJson(res, result.failureKind === "not-found" ? 404 : 400, {
      error: result.message,
    });
    return;
  }
  sendJson(res, 200, result.data);
}

/**
 * `POST /api/chat/cancel` (#303) — the chat panel's Stop button. Sends ACP
 * `session/cancel` for the turn in flight; the turn then ends through the
 * normal path with a `chat-done` whose `stopReason` is `cancelled` on
 * `/api/chat/stream`. No body. 202 once the cancel notification is on its
 * way; 409 when nothing is running (no agent selected, or the agent is
 * idle) — the author pressed Stop on a turn that had already ended.
 *
 * What stopping does NOT do: a `slidra` command the agent had already
 * launched keeps running to completion (each command is atomic), and
 * nothing already written to the presentation is rolled back — the
 * author's undo is the tool for that.
 */
async function handleChatCancelPost(
  manager: AgentManager,
  res: ServerResponse,
): Promise<void> {
  try {
    console.log(`[chat] ${new Date().toISOString()} cancel requested`);
    await manager.cancel();
  } catch (error) {
    sendJson(res, 409, {
      error:
        error instanceof Error
          ? error.message
          : "There is no turn currently in progress to stop",
    });
    return;
  }
  sendJson(res, 202, { ok: true });
}

/**
 * `POST /api/chat/new` — the chat panel's "new session" button. Throws the
 * current ACP session away and starts a fresh one with the same agent, so
 * the next message arrives in a conversation with no history. No body.
 * 409 while the agent holds the editing floor, or with no agent selected.
 *
 * The presentation itself is untouched: this clears the conversation, not
 * the deck.
 */
async function handleChatNewPost(
  manager: AgentManager,
  res: ServerResponse,
): Promise<void> {
  try {
    console.log(`[chat] ${new Date().toISOString()} new session requested`);
    await manager.newSession();
  } catch (error) {
    sendJson(res, 409, {
      error:
        error instanceof Error
          ? error.message
          : "Failed to restart conversation",
    });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * `POST /api/agent/select` (NOOP-230 §4.4). `kind` is the only accepted
 * body shape; `AgentManager.select` itself decides whether this is a same-
 * kind settings-only write or an actual session swap (see its own
 * docstring) — this handler only translates its outcome/errors to HTTP.
 */
async function handleAgentSelectPost(
  manager: AgentManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const kind = (body as { kind?: unknown } | null)?.kind;
  const knownAdapters = manager.knownAdapters();
  if (!isAgentKind(kind, knownAdapters)) {
    sendJson(res, 400, {
      error: `kind must be one of: ${knownAdapters.map((spec) => spec.kind).join(", ")}`,
    });
    return;
  }
  try {
    const status = await manager.select(kind);
    sendJson(res, 200, {
      ok: true,
      current: status.current,
      source: status.source,
    });
  } catch (error) {
    if (error instanceof AgentSwitchLockedError) {
      sendJson(res, 409, { error: error.message, reason: "editing" });
      return;
    }
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Failed to select agent",
    });
  }
}

/**
 * `POST /api/agent/model` — the chat panel's model picker. `modelId` must be
 * one of `GET /api/agent`'s `models[].id`; the switch goes to the live ACP
 * session (establishing one first if no message has been sent yet) and is
 * persisted per agent kind. A `SlidraError` (mid-turn, unknown model, no
 * agent) is the author's problem to read, so it comes back as 409 with its
 * own wording rather than a generic 500.
 */
async function handleAgentModelPost(
  manager: AgentManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const modelId = (body as { modelId?: unknown } | null)?.modelId;
  if (typeof modelId !== "string" || modelId === "") {
    sendJson(res, 400, { error: "modelId must be a non-empty string" });
    return;
  }
  try {
    const status = await manager.setModel(modelId);
    sendJson(res, 200, {
      ok: true,
      modelId: status.modelId,
      model: status.model,
    });
  } catch (error) {
    if (error instanceof SlidraError) {
      sendJson(res, 409, { error: error.message });
      return;
    }
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Failed to switch model",
    });
  }
}

/**
 * `POST /api/export` (NOOP-93 §4.4). Starts a job through
 * `ExportJobManager.start()` — which is also the whole 409 gate: the
 * concurrency check and the start happen inside that one synchronous call,
 * so nothing can race between "is one already running" and "start one".
 * `run` (the closure passed in here) is where this route's own knowledge —
 * the presentation id, this server's own address for
 * `render.ts`'s Playwright to navigate to — meets `render.ts`'s generic
 * "drive one headless page, produce a PDF" job.
 */
async function handleExportPost(
  exportJobManager: ExportJobManager,
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
    sendJson(res, 400, { error: "format must be pdf or pdf-frames" });
    return;
  }
  const format = (body as { format?: unknown } | null)?.format;
  if (format !== "pdf" && format !== "pdf-frames") {
    sendJson(res, 400, { error: "format must be pdf or pdf-frames" });
    return;
  }

  let jobId: string;
  try {
    jobId = exportJobManager.start(
      format,
      (event) => changeBroadcaster.broadcast("export", event),
      async (id: string, jobFormat: ExportFormat, onRunning, onProgress) => {
        const project = await loadProject(presentationId);
        const fileName = exportFileName(project.name, jobFormat);
        const outputPath = path.join(
          resolveSlidraHome(),
          "exports",
          id,
          fileName,
        );
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
    sendJson(res, 409, { error: "An export job is already in progress" });
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
async function handleExportFileGet(
  exportJobManager: ExportJobManager,
  jobId: string,
  res: ServerResponse,
): Promise<void> {
  const filePath = exportJobManager.getFilePath(jobId);
  if (!filePath) {
    sendJson(res, 404, { error: "Export file not found" });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    sendJson(res, 404, { error: "Export file not found" });
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
 * `undo <id> --json` / `redo <id> --json` (plan §3.7): neither is part of
 * `COMMAND_WHITELIST` (they are not reachable through `POST /api/command`),
 * so this is a direct `runJsonCommand` call rather than going through
 * `slidra/argv.ts`'s encoder table.
 */
/**
 * `POST /api/editing/begin` — the lease T2 (NOOP-91)'s drag UI is meant to
 * take/renew (plan §4.1). Refused with 409 while the agent holds the
 * floor; otherwise starts (or renews) the human lease and returns 200.
 *
 * [E10.T5]: "crate decides first, Node applies" (Dev-Leader's ruling on
 * NOOP-643) — the crate's own `POST /editing/begin` is asked FIRST; a
 * refusal there is relayed as-is and Node's local `EditingLock` is left
 * untouched (its state must never claim a lease the crate itself did not
 * grant). Only once the crate agrees does this call the local object's
 * existing `beginHumanEdit()`, which is what actually fires the
 * `frozen`/`unfrozen`-adjacent event plumbing (`markDirty`,
 * `editing-frozen`/`unfrozen` broadcasts) — nothing about those events
 * changes. The split editor now calls the crate directly; this dual-write remains
 * only for the transitional combined `startServe` harness and its legacy tests,
 * until the launcher switches the production entry point.
 */
async function handleEditingBeginPost(
  deckServer: DeckServerClient,
  deckId: string,
  editingLock: EditingLock,
  res: ServerResponse,
): Promise<void> {
  const upstream = await postDeckServerJson(
    deckServer,
    "/editing/begin",
    deckId,
    "editor",
  );
  if (upstream.status !== 200) {
    sendJson(res, upstream.status, upstream.body);
    return;
  }
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
        throw new SlidraError("Server is shutting down");
      }
      const stream = openEventStream(res);
      streams.add(stream);
      const detach = manager.attachStream((event, data) =>
        stream.send(event, data),
      );
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

/**
 * Binary-safe counterpart of `readBody` — used for `/api/asset`'s upload
 * body, which `readBody`'s `toString("utf8")` would corrupt for any
 * non-text asset. Aborts (never destructive: it stops accumulating rather
 * than throwing mid-stream) once `limitBytes` is exceeded, so an oversized
 * upload cannot buffer arbitrarily far past the limit before being
 * rejected — same non-destructive-overflow posture `asset-upload.ts` used
 * to apply while streaming.
 */
function readBodyBuffer(
  req: IncomingMessage,
  limitBytes: number,
): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    req.on("data", (chunk: Buffer) => {
      if (overLimit) return;
      total += chunk.length;
      if (total > limitBytes) {
        overLimit = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(overLimit ? "too-large" : Buffer.concat(chunks)),
    );
    req.on("error", reject);
  });
}

const DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID = "deck-lifecycle";

/** Same order-of-magnitude cap `MAX_ASSET_BODY_BYTES` uses for its own upload — every deck-lifecycle JSON body here is a handful of fields, never large. */
const MAX_DECK_LIFECYCLE_JSON_BODY_BYTES = 64 * 1024;
/** `open-endpoint.ts`'s own `MAX_OPEN_BODY_BYTES` — half of `MAX_ASSET_BODY_BYTES`'s headroom: a `.slidra` with no large embedded media is far smaller than this. */
const MAX_OPEN_BODY_BYTES = 16 * 1024 * 1024;

/** Reads and buffers a request body up to `limitBytes`, sending the standard 400 and returning `null` on overflow — the one place every deck-lifecycle forward below shares this check. */
async function readDeckLifecycleBody(
  req: IncomingMessage,
  res: ServerResponse,
  limitBytes: number,
): Promise<Buffer | null> {
  const body = await readBodyBuffer(req, limitBytes);
  if (body === "too-large") {
    sendJson(res, 400, {
      error: `Request body too large (limit ${limitBytes} bytes)`,
    });
    return null;
  }
  return body;
}

/** A thin, uniform "forward this JSON body, relay the response verbatim" — every deck-lifecycle POST route below except `/deck/rename`/`/deck/delete` (which need the bound-deck guard first) and `/open` (raw bytes, its own header) is exactly this. */
async function forwardDeckLifecycleJsonPost(
  deckServer: DeckServerClient,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readDeckLifecycleBody(
    req,
    res,
    MAX_DECK_LIFECYCLE_JSON_BODY_BYTES,
  );
  if (body === null) return;
  const upstream = await postDeckServerJson(
    deckServer,
    path,
    DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
    "editor",
    { body },
  );
  sendJson(res, upstream.status, upstream.body);
}

/** `POST /api/new` — forwards to the crate's `POST /new`. */
async function handleNewForward(
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await forwardDeckLifecycleJsonPost(deckServer, "/new", req, res);
}

/**
 * `POST /api/open` — a browser's `<input type="file">` only ever hands
 * over bytes, never a real filesystem path, so this keeps the raw-body +
 * `x-slidra-file-name` header shape `POST /api/asset`'s own byte-upload
 * mode uses, forwarded to the crate's `POST /open`.
 */
async function handleOpenForward(
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readDeckLifecycleBody(req, res, MAX_OPEN_BODY_BYTES);
  if (body === null) return;
  const fileNameHeader = req.headers["x-slidra-file-name"];
  const extraHeaders: Record<string, string> = {};
  if (typeof fileNameHeader === "string")
    extraHeaders["x-slidra-file-name"] = fileNameHeader;
  const upstream = await postDeckServerJson(
    deckServer,
    "/open",
    DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
    "editor",
    { body, extraHeaders },
  );
  sendJson(res, upstream.status, upstream.body);
}

/** `POST /api/deck/import` — forwards to the crate's `POST /deck/import`. */
async function handleDeckImportForward(
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await forwardDeckLifecycleJsonPost(deckServer, "/deck/import", req, res);
}

/** `POST /api/deck/resolve` — forwards to the crate's `POST /deck/resolve`. */
async function handleDeckResolveForward(
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await forwardDeckLifecycleJsonPost(deckServer, "/deck/resolve", req, res);
}

/** A JSON body's `id` field, if it parses and is a non-empty string — `null` on anything else (malformed JSON, missing/wrongly-typed `id`), which the bound-deck guard below treats as "cannot tell, not bound" and simply forwards, letting the crate's own body validation produce the canonical 400. */
function extractDeckIdField(rawBody: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    const id = (parsed as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * `POST /api/deck/rename` — the crate's own `deck_store::rename_deck` has
 * NO "is this the currently-bound deck" guard (`deck_lifecycle.rs`'s own
 * doc comment: that state lives in `deck-switch.ts`, a Node-side concern
 * this ticket deliberately did not move). So this is the one deck-lifecycle
 * route that is not a pure thin forward: Node reads the body once, checks
 * the bound deck itself, and only then forwards the SAME already-read
 * bytes — mirrors `deck-store.ts`'s old `DeckBoundError` wording/shape
 * exactly (`{error, reason: "deck-bound"}`), since `deck-switch.test.ts`'s
 * own contract test for this ("AC5's other half") depends on it.
 */
async function handleDeckRenameForward(
  deckSession: DeckSession,
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readDeckLifecycleBody(
    req,
    res,
    MAX_DECK_LIFECYCLE_JSON_BODY_BYTES,
  );
  if (body === null) return;
  const id = extractDeckIdField(body);
  if (id !== null && id === deckSession.currentId()) {
    sendJson(res, 409, {
      error: `cannot rename the deck that is currently open: ${id}`,
      reason: "deck-bound",
    });
    return;
  }
  const upstream = await postDeckServerJson(
    deckServer,
    "/deck/rename",
    DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
    "editor",
    { body },
  );
  sendJson(res, upstream.status, upstream.body);
}

/** `POST /api/deck/delete` — same bound-deck guard as `/api/deck/rename` above, and for the same reason. */
async function handleDeckDeleteForward(
  deckSession: DeckSession,
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readDeckLifecycleBody(
    req,
    res,
    MAX_DECK_LIFECYCLE_JSON_BODY_BYTES,
  );
  if (body === null) return;
  const id = extractDeckIdField(body);
  if (id !== null && id === deckSession.currentId()) {
    sendJson(res, 409, {
      error: `cannot delete the deck that is currently open: ${id}`,
      reason: "deck-bound",
    });
    return;
  }
  const upstream = await postDeckServerJson(
    deckServer,
    "/deck/delete",
    DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
    "editor",
    { body },
  );
  sendJson(res, upstream.status, upstream.body);
}

/** `POST /api/identity/sign-in` — forwards to the crate's `POST /identity/sign-in`. */
async function handleIdentitySignInForward(
  deckServer: DeckServerClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await forwardDeckLifecycleJsonPost(deckServer, "/identity/sign-in", req, res);
}

/** `POST /api/identity/sign-out` — forwards to the crate's `POST /identity/sign-out`; no body to read, matching the old handler's own contract. */
async function handleIdentitySignOutForward(
  deckServer: DeckServerClient,
  res: ServerResponse,
): Promise<void> {
  const upstream = await postDeckServerJson(
    deckServer,
    "/identity/sign-out",
    DECK_LIFECYCLE_CREDENTIAL_WORKBENCH_ID,
    "editor",
  );
  sendJson(res, upstream.status, upstream.body);
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
  return path.join(here, "../../../packages/web/dist");
}

/**
 * The one font every build ships (`DEFAULT_FONT_FAMILY`), read directly off
 * disk rather than through `packages/core` ([E4.T9]/F7 — the server no
 * longer imports that package). Repo-root `assets/fonts/` is the same
 * physical file the Rust binary's own `include_bytes!` embeds
 * (`crates/slidra/src/presentation.rs`) — both moved together off
 * `packages/core/src/assets/fonts/` when that package was deleted
 * ([E4.T12]).
 */
function resolveDefaultFontPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "../../../assets/fonts/NotoSansTC-Presentation.ttf");
}

async function serveStatic(
  staticDir: string,
  pathname: string,
  res: ServerResponse,
  bootstrap?: EditorBootstrap,
): Promise<void> {
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
    const body = isRoot && bootstrap !== undefined ? injectEditorBootstrap(data, bootstrap) : data;
    res.writeHead(200, { "Content-Type": staticContentTypeFor(filePath) });
    res.end(body);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // A real I/O failure (permissions, etc.) — never disguise it as a
      // successful page load.
      sendJson(res, 500, { error: "Failed to read static file" });
      return;
    }
    if (isRoot) {
      // index.html itself is missing: the frontend was never built at all.
      sendJson(res, 500, {
        error: "Frontend has not been built yet, run build first",
      });
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
