// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SlidraError, SlidraNotFoundError } from "./slidra/errors.js";
import { runJsonCommand } from "./slidra/command.js";
import { readProjectsRegistry, resolveSlidraHome } from "./slidra/home.js";
import type { AgentAdapterConfig } from "./agent/session.js";
import { collectSlashCommands, resolveSkillDirs, type SkillDirs, type SlashCommand } from "./agent/commands.js";
import { deployAgentWorkdir } from "./agent/workdir.js";
import { createSandboxRoot } from "./sandbox/sandbox-root.js";
import { createSandboxLauncher, setActiveLauncher } from "./sandbox/launcher.js";
import { setActivePolicy } from "./sandbox/policy.js";
import { deployShimWrapper } from "./sandbox/shim-wrapper.js";
import { createShimToken, setShimConfig } from "./sandbox/shim-config.js";
import { handleShimExec } from "./sandbox/shim-endpoint.js";
import type { FileEntryPolicy, WorkbenchPolicy } from "./policy/types.js";
import { AgentManager, AgentSwitchLockedError, type AgentSource } from "./agent/manager.js";
import { isAgentKind, resolveAdapterConfig, type AgentKind } from "./agent/adapters.js";
import type { CommandRunner } from "./agent/probe.js";
import { openEventStream, type EventStream } from "./sse.js";
import { createChangeBroadcaster } from "./changes.js";
import type { ChangeBroadcaster } from "./changes.js";
import { handleCommandPost } from "./command-endpoint.js";
import { handleAssetPost } from "./asset-upload.js";
import {
  handleDecksGet,
  handleDeletePost,
  handleImportPost,
  handleNewPost,
  handleOpenPost,
  handleRenamePost,
  handleResolvePost,
  handleThumbnailGet,
} from "./open-endpoint.js";
import { createLocalDeckStore, DeckNameConflictError, type DeckStore } from "./storage/deck-store.js";
import { createAnonymousProvider } from "./identity/anonymous-provider.js";
import { handleIdentityGet, handleIdentitySignIn, handleIdentitySignOut } from "./identity/routes.js";
import { createIdentitySession, type IdentitySession } from "./identity/session.js";
import type { IdentityProvider } from "./identity/types.js";
import { broadcastSaveState, createSaveController, type SaveController } from "./save-state.js";
import { EditingLock, EditingLockConflictError } from "./editing-lock.js";
import {
  handleAssetsRoute,
  handleEffectsRoute,
  handleFilesRoute,
  handlePresentationRoute,
  handleRawRoute,
  loadProject,
} from "./read-routes.js";
import { ExportJobManager, type ExportFormat } from "./export/job.js";
import { renderExportPdf } from "./export/render.js";
import { exportFileName } from "./export/output-name.js";
import { createDeckSession, DeckSwitchConflictError, type DeckIdentity, type DeckSession } from "./deck-switch.js";

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
  /**
   * [E6.T9]: the identity providers this server registers, and the one
   * seam production and tests differ on. Omitted (`cli.ts`, the e2e
   * harness) means exactly `[anonymous]` — the only provider a real
   * deployment offers until a real one (Email Magic Link) ships. Tests
   * pass `{ providers: [createFakeProvider()] }` (or a locally-built
   * two-phase provider, AC7) to sign in without a real identity backend.
   */
  identity?: { providers: IdentityProvider[] };
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
export async function startServe(options: ServeOptions): Promise<RunningServer> {
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

  if (options.presentationId !== undefined) {
    initialDeck = await resolveDeckIdentity(options.presentationId);
    initialWorkdir = await deployAgentWorkdir(sandboxRoot.path, options.presentationId, options.policy);
  }

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
  const changeBroadcaster = createChangeBroadcaster(initialDeck?.id ?? null);
  disposers.push(() => changeBroadcaster.dispose());

  // NOOP-422 (Continuous save): owns the debounced write-back that replaced
  // the manual Save button. Built right after the broadcaster/editingLock
  // it depends on, before anything that might already mark the deck dirty.
  const saveController = createSaveController({
    presentationId: initialDeck?.id ?? null,
    broadcaster: changeBroadcaster,
    editingLock,
  });
  // Registered FIRST (unshift, not push) — server shutdown must write back
  // any pending debounced edit before anything else tears down, including
  // the broadcaster itself (AC3/AC5: closing must never abandon an edit
  // still sitting in the debounce window).
  disposers.unshift(async () => {
    const before = await saveController.state();
    if (before.known && before.dirty) {
      process.stderr.write(`Writing unsaved changes to ${before.fileName}…\n`);
    }
    await saveController.dispose();
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

  // [E6.T2]: built once per server, injected into every deck lifecycle
  // route in `open-endpoint.ts` — no route constructs its own.
  // `getCurrentDeckId` closes over `deckSession` (declared below) so
  // rename/delete refuse the deck this server currently has bound — safe
  // for the same reason the request handler closure below is: neither runs
  // before `deckSession` actually exists.
  const deckStore = createLocalDeckStore({ getCurrentDeckId: () => deckSession.currentId() });

  // [E6.T9]: built once per server, alongside deckStore — the identity
  // routes below and GET /api/decks' visibility resolver both close over
  // this one session, so "who is signed in" and "which decks are visible"
  // can never disagree within a single serve process.
  const identityProviders = options.identity?.providers ?? [createAnonymousProvider()];
  const identitySession = createIdentitySession(identityProviders, deckStore);

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
  const server = http.createServer((req, res) => {
    void handleRequest(
      deckSession,
      deckStore,
      identitySession,
      staticDir,
      manager,
      chatStreams,
      changeBroadcaster,
      editingLock,
      saveController,
      exportJobManager,
      serverAddress,
      computeSlashCommands,
      sandboxRoot.path,
      shimToken,
      options.policy.fileEntry,
      req,
      res,
    );
  });

  await listen(server, port, host);
  const actualPort = (server.address() as AddressInfo).port;
  serverAddress.port = actualPort;

  setShimConfig({ token: shimToken, baseUrl: `http://${host}:${actualPort}` });
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
    options.initialAgent ?? (options.agent ? { kind: options.agent.kind, source: "cli" } : { kind: null, source: "none" });
  const fallbackAgent = options.agent;
  const resolveAdapter =
    options.agentManager?.resolveAdapter ??
    ((kind: AgentKind): AgentAdapterConfig =>
      fallbackAgent && kind === fallbackAgent.kind ? fallbackAgent : resolveAdapterConfig(kind));
  const manager = new AgentManager({
    presentationId: initialDeck?.id ?? null,
    editingLock,
    policy: options.policy,
    workdir: initialWorkdir,
    initial: initialAgent,
    runCommand: options.agentManager?.runCommand,
    resolveAdapter,
    onAgentChanged: (payload) => changeBroadcaster.broadcast("agent-changed", payload),
    onModelChanged: (payload) => changeBroadcaster.broadcast("agent-model-changed", payload),
    initialModels: options.initialModels,
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
  // The agent writes to the deck through the CLI directly, never through an
  // HTTP route — its turn ending (releasing the floor) is the only
  // observation point continuous-save has for "the agent may have just
  // written something" (plan §4(a)'s table).
  const onUnfrozen = () => {
    changeBroadcaster.broadcast("editing-unfrozen", {});
    saveController.markDirty();
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
    resolveDeck: resolveDeckIdentity,
    guard: () => deckMutationGuard(editingLock, exportJobManager),
    unbind: async (outgoing) => {
      await changeBroadcaster.retarget(null);
      await manager.retarget(null);
      // AC9, "switching decks": the outgoing deck's agent working files
      // never persist inside the sandbox past the switch.
      await sandboxRoot.disposePresentation(outgoing.id);
    },
    bind: async (incoming) => {
      const workdir = await deployAgentWorkdir(sandboxRoot.path, incoming.id, options.policy);
      await manager.retarget({ id: incoming.id, workdir });
      await changeBroadcaster.retarget(incoming.id);
      // Flushes whatever is still pending on the OUTGOING deck (this
      // controller's own `presentationId` is still the outgoing id at this
      // point — `retarget` hasn't run yet) before pointing itself at the
      // incoming one (NOOP-422 §4's retarget contract).
      await saveController.retarget(incoming.id);
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
}

/**
 * Resolves `id` to its public identity (NOOP-433's `deck-switch.ts` injects
 * this as `resolveDeck`) — `loadProject` alone already throws the exact
 * `SlidraNotFoundError` message ("no presentation found for id: <id>") an
 * unknown id must report (NOOP-433 §4's table); `readProjectsRegistry` is
 * consulted separately only for `sourcePath`, since `loadProject`'s own
 * `ProjectJson` never carries a real filesystem path (ADR-0003). A registry
 * entry with no `sourcePath` (or, in principle, no entry at all for an id
 * `loadProject` otherwise accepts) is legal — `sourcePath` is just `null`,
 * never a reason to refuse the switch (NOOP-433 §4's table, "合法但奇怪" row).
 */
async function resolveDeckIdentity(id: string): Promise<DeckIdentity> {
  const project = await loadProject(id);
  const registry = await readProjectsRegistry();
  const entry = registry.get(id);
  return { id, name: project.name, sourcePath: entry?.sourcePath ?? null };
}

/** `DeckIdentity` -> the shape sent over the wire — never `sourcePath` itself (ADR-0003, NOOP-433 §7 decision 2), only its basename. */
function toPublicDeck(deck: DeckIdentity): { id: string; name: string | null; fileName: string | null } {
  return { id: deck.id, name: deck.name, fileName: deck.sourcePath !== null ? path.basename(deck.sourcePath) : null };
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
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
  deckStore: DeckStore,
  identitySession: IdentitySession,
  staticDir: string,
  manager: AgentManager,
  chatStreams: ChatStreamRegistry,
  changeBroadcaster: ChangeBroadcaster,
  editingLock: EditingLock,
  saveController: SaveController,
  exportJobManager: ExportJobManager,
  serverAddress: { host: string; port: number },
  computeSlashCommands: () => Promise<SlashCommand[]>,
  sandboxRootPath: string,
  shimToken: string,
  fileEntryPolicy: FileEntryPolicy,
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
    if (req.headers.origin === "null" && !(req.url ?? "").startsWith("/api/raw/")) {
      sendJson(res, 403, { error: "Does not accept requests from an opaque origin (Origin: null)" });
      return;
    }

    // Parsed before the method gate so POST /api/chat can be routed
    // explicitly — every other POST still gets the same 405 it always did.
    const url = new URL(req.url ?? "/", "http://localhost");

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
          sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to create conversation" });
        }
        return;
      }
      if (url.pathname === "/api/deck/switch") {
        // NOOP-433: never gated on `requireDeck` below — switching is the
        // one write route that must work with no deck open (entering a
        // deck for the first time) as well as with one already open.
        await handleDeckSwitchPost(deckSession, changeBroadcaster, saveController, req, res);
        return;
      }
      if (url.pathname === "/api/new") {
        // [E6.T2]: deck-independent (never gated on `requireDeck`/the
        // editing-lock below) — creates a new deck in the deck folder, does
        // not switch to it and does not touch whichever deck this server
        // currently has open, if any.
        await handleNewPost(deckStore, req, res);
        return;
      }
      if (url.pathname === "/api/open") {
        // [E6.T2]: same "deck-independent" contract as /api/new above.
        await handleOpenPost(deckStore, req, res);
        return;
      }
      if (url.pathname === "/api/deck/import") {
        await handleImportPost(deckStore, req, res);
        return;
      }
      if (url.pathname === "/api/deck/rename") {
        await handleRenamePost(deckStore, req, res);
        return;
      }
      if (url.pathname === "/api/deck/rename-current") {
        // The title bar's own rename — the one case `/api/deck/rename`
        // refuses (the deck this server currently has bound). Never gated
        // on `requireDeck`/the editing-lock check below: it has its own
        // no-deck/editing/exporting guards, matching `/api/deck/switch`.
        await handleRenameCurrentPost(deckSession, deckStore, changeBroadcaster, saveController, editingLock, exportJobManager, req, res);
        return;
      }
      if (url.pathname === "/api/deck/delete") {
        await handleDeletePost(deckStore, req, res);
        return;
      }
      if (url.pathname === "/api/deck/resolve") {
        // [E6.T4]: deck-independent, like /api/new and /api/open above —
        // lazily registers a deck folder entry Deck Space's list never
        // minted an id for.
        await handleResolvePost(deckStore, req, res);
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
      if (url.pathname === "/api/command") {
        // NOOP-91 §4.9: the front end's only write path. Whitelisting and
        // the server-owned presentation id both live inside the handler,
        // not here. The freeze gate (T5, NOOP-93/#110) DOES live here, at
        // the same call-site level as /api/undo and /api/redo below: agent
        // holding the floor refuses with 409, idle/human pass through
        // unchanged — this route never blocks the agent's own commands.
        // NOOP-433 §4's table: the no-deck guard is checked first, ahead of
        // the editing-lock gate.
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        if (editingLock.getState() === "agent") {
          sendJson(res, 409, { error: new EditingLockConflictError().message });
          return;
        }
        const wrote = await handleCommandPost(deckId, req, res);
        if (wrote) saveController.markDirty();
        return;
      }
      if (url.pathname === "/api/asset") {
        // T3/NOOP-142: the same "agent holds the floor" 409 gate as
        // /api/command, at the same call-site level — a Ribbon-driven
        // asset upload is a human write, not exempt from the single-editor
        // lock just because it does not spawn the slidra binary.
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        if (editingLock.getState() === "agent") {
          sendJson(res, 409, { error: new EditingLockConflictError().message });
          return;
        }
        const wrote = await handleAssetPost(deckId, req, res, fileEntryPolicy);
        if (wrote) saveController.markDirty();
        return;
      }
      if (url.pathname === "/api/save/flush") {
        // NOOP-422: replaces the old `POST /api/save` — the only routes that
        // ever call this now are the Retry action on a failed save, the
        // unsaved-changes modal's "Save now", and `applyTemplateToSlides`'s
        // pre-dispatch save. Same "agent holds the floor" 409 gate every
        // other human write route above uses.
        //
        // [E6.T2] moved `/api/open`/`/api/new` above to deck-independent,
        // deckStore-backed routes that never touch this server's
        // currently-bound presentation — so, unlike before NOOP-422, neither
        // route retargets or flushes saveController; switching TO a newly
        // created/opened deck (and retargeting saveController) is
        // `POST /api/deck/switch`'s job (`handleDeckSwitchPost` below).
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        if (editingLock.getState() === "agent") {
          sendJson(res, 409, { error: new EditingLockConflictError().message });
          return;
        }
        const state = await saveController.flush();
        sendJson(res, 200, state);
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
        await handleExportPost(exportJobManager, deckId, serverAddress, changeBroadcaster, req, res);
        return;
      }
      if (url.pathname === "/api/undo") {
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        const wrote = await handleUndoRedoPost(editingLock, deckId, runUndo, res);
        if (wrote) saveController.markDirty();
        return;
      }
      if (url.pathname === "/api/redo") {
        const deckId = requireDeck(deckSession, res);
        if (deckId === null) return;
        const wrote = await handleUndoRedoPost(editingLock, deckId, runRedo, res);
        if (wrote) saveController.markDirty();
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
      if (url.pathname === "/api/identity/sign-in") {
        await handleIdentitySignIn(identitySession, req, res);
        return;
      }
      if (url.pathname === "/api/identity/sign-out") {
        await handleIdentitySignOut(identitySession, res);
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
      // visible set is identity's union of "Anonymous" plus the current
      // identity's own decks, not the whole folder.
      await handleDecksGet(deckStore, url, res, () => identitySession.visibleDecks());
      return;
    }

    if (url.pathname === "/api/identity") {
      // [E6.T9] AC1: the user block's initial render — current identity
      // (null when anonymous) plus every registered provider.
      handleIdentityGet(identitySession, res);
      return;
    }

    if (url.pathname === "/api/decks/thumbnail") {
      // [E6.T4]: deck-independent, same contract as /api/decks above.
      await handleThumbnailGet(deckStore, url, req, res);
      return;
    }

    if (url.pathname === "/api/save-state") {
      // NOOP-93 §4.2: no-replay SSE (sse.ts) means the *initial* state on
      // load/reconnect must come from a plain GET, same pattern as
      // /api/editing above — never inferred from the last `save-state`
      // event, which a fresh page load never saw.
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      const state = await saveController.state();
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
      const bytes = await readFile(resolveDefaultFontPath());
      res.writeHead(200, { "content-type": "font/ttf", "content-length": String(bytes.byteLength) });
      res.end(bytes);
      return;
    }

    if (url.pathname === "/api/presentation") {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      await handlePresentationRoute(deckId, res);
      return;
    }

    if (url.pathname === "/api/assets") {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      await handleAssetsRoute(deckId, res);
      return;
    }

    if (url.pathname.startsWith("/api/files/")) {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      const virtualPath = decodeURIComponent(url.pathname.slice("/api/files/".length));
      await handleFilesRoute(deckId, virtualPath, res);
      return;
    }

    if (url.pathname.startsWith("/api/effects/")) {
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      const virtualPath = decodeURIComponent(url.pathname.slice("/api/effects/".length));
      await handleEffectsRoute(deckId, virtualPath, res);
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
      // need this route, so it calls `cat` directly (`readPresentationBytes`)
      // rather than through any agent-reachable command.
      const deckId = requireDeck(deckSession, res);
      if (deckId === null) return;
      let virtualPath: string;
      try {
        virtualPath = decodeURIComponent(url.pathname.slice("/api/raw/".length));
      } catch {
        sendJson(res, 400, { error: "Invalid path encoding" });
        return;
      }
      // The Range header is read here, at the one place that has `req`, and
      // handed on as a plain value: handleRawRoute stays a function of
      // (path, response, range) rather than growing a dependency on the
      // whole request object it has no other use for (ticket #13).
      await handleRawRoute(deckId, virtualPath, res, req.headers.range);
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
    return { reason: "exporting", message: "An export job is already in progress" };
  }
  return null;
}

function requireDeck(deckSession: DeckSession, res: ServerResponse): string | null {
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
 * (§4's table). The `deck-changed`/`presentation-changed`/`save-state`
 * broadcast only fires when a switch actually happened — the same-id
 * short-circuit rebuilds nothing, so there is nothing to announce.
 */
async function handleDeckSwitchPost(
  deckSession: DeckSession,
  changeBroadcaster: ChangeBroadcaster,
  saveController: SaveController,
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
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to switch deck" });
    return;
  }

  if (result.switched) {
    changeBroadcaster.broadcast("deck-changed", { deck: toPublicDeck(result.deck) });
    changeBroadcaster.broadcast("presentation-changed", {});
    // `deckSession`'s own `bind` (serve.ts's `createDeckSession` call) has
    // already run `saveController.retarget(result.deck.id)` by the time
    // `switchTo` resolves — this broadcasts that already-updated state.
    await broadcastSaveState(changeBroadcaster, saveController);
  }
  sendJson(res, 200, { ok: true, switched: result.switched, deck: toPublicDeck(result.deck) });
}

/**
 * `POST /api/deck/rename-current` — the title bar's inline rename. Body:
 * `{ name: string }`; the deck to rename is always whichever one
 * `deckSession` currently has bound (there is no `id` in the body). Refuses
 * with the same `{reason:"editing"}`/`{reason:"exporting"}` conflicts a
 * switch would (`guard`), and with `{reason:"no-deck"}` when nothing is
 * open. On success, flushes any pending debounced save against the OLD path
 * first, renames the file (`DeckStore.renameBound`), then re-points the
 * file watcher at the new path (`changeBroadcaster.retarget`) — `retarget`
 * always tears down and rebuilds the watcher, even for the same id, so this
 * is enough to make live reload see the renamed file.
 */
async function handleRenameCurrentPost(
  deckSession: DeckSession,
  deckStore: DeckStore,
  changeBroadcaster: ChangeBroadcaster,
  saveController: SaveController,
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

  try {
    // Settles any edit still sitting in the debounce window against the
    // OLD path before that path stops existing.
    await saveController.flush();
    const { fileName } = await deckStore.renameBound(id, name);
    // `deckSession.current()` (GET /api/deck's own answer) otherwise keeps
    // reporting the pre-rename name/sourcePath until the next switch.
    await deckSession.refreshCurrent();
    await changeBroadcaster.retarget(id);
    // `renameBound`'s own savedAt snapshot (a Node-side `stat()` read, same
    // idiom `deck-store.ts` already uses for `create`/`rename`) is not
    // reliable here: `refreshCurrent`'s `slidra cat` runs a real subprocess
    // between that snapshot and this line, and under CI's timing that was
    // observed to nudge the file's mtime past it, permanently reading the
    // freshly-renamed deck as dirty. Forcing one real write-back instead
    // re-establishes `savedAt` through the SAME Rust-`pack`-authored
    // mechanism every other save already relies on (`slidra/save-state.ts`'s
    // own docstring) — proven immune to a read run after it, unlike a
    // Node-side stat guess. `flush` also broadcasts "save-state" itself, so
    // no separate `broadcastSaveState` call is needed.
    saveController.markDirty();
    await saveController.flush();
    sendJson(res, 200, { ok: true, fileName });
  } catch (error) {
    if (error instanceof DeckNameConflictError) {
      sendJson(res, 409, { error: error.message, reason: "name-conflict" });
      return;
    }
    if (error instanceof SlidraNotFoundError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Rename failed" });
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
    sendJson(res, 409, { error: "No agent selected, choose one in settings first", reason: "unset", kind: null });
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
  const rawDisplayText = (body as { displayText?: unknown } | null)?.displayText;
  const displayText = typeof rawDisplayText === "string" ? rawDisplayText : undefined;
  // #303: one line per author message so a turn that starts unexpectedly
  // (e.g. right after a cancel) can be traced to the request that caused it.
  console.log(`[chat] ${new Date().toISOString()} message ${JSON.stringify(text.slice(0, 60))}${text.length > 60 ? "…" : ""}`);
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
async function handleChatHistoryGet(deckId: string, searchParams: URLSearchParams, res: ServerResponse): Promise<void> {
  const args = ["chat-history", deckId];
  const limit = searchParams.get("limit");
  if (limit !== null) args.push("--limit", limit);
  const query = searchParams.get("query");
  if (query !== null) args.push("--query", query);

  const result = await runJsonCommand<{ entries: unknown[]; total: number; truncated: boolean }>(args);
  if (!result.ok) {
    sendJson(res, result.failureKind === "not-found" ? 404 : 400, { error: result.message });
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
async function handleChatCancelPost(manager: AgentManager, res: ServerResponse): Promise<void> {
  try {
    console.log(`[chat] ${new Date().toISOString()} cancel requested`);
    await manager.cancel();
  } catch (error) {
    sendJson(res, 409, { error: error instanceof Error ? error.message : "There is no turn currently in progress to stop" });
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
async function handleChatNewPost(manager: AgentManager, res: ServerResponse): Promise<void> {
  try {
    console.log(`[chat] ${new Date().toISOString()} new session requested`);
    await manager.newSession();
  } catch (error) {
    sendJson(res, 409, { error: error instanceof Error ? error.message : "Failed to restart conversation" });
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
async function handleAgentSelectPost(manager: AgentManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }
  const kind = (body as { kind?: unknown } | null)?.kind;
  if (!isAgentKind(kind)) {
    sendJson(res, 400, { error: "kind must be one of: claude, codex, pi" });
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
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to select agent" });
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
async function handleAgentModelPost(manager: AgentManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    sendJson(res, 200, { ok: true, modelId: status.modelId, model: status.model });
  } catch (error) {
    if (error instanceof SlidraError) {
      sendJson(res, 409, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to switch model" });
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
        const outputPath = path.join(resolveSlidraHome(), "exports", id, fileName);
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
async function handleExportFileGet(exportJobManager: ExportJobManager, jobId: string, res: ServerResponse): Promise<void> {
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
async function runCommandRestoringPaths(name: "undo" | "redo", presentationId: string): Promise<{ restoredPaths: string[] }> {
  const result = await runJsonCommand<{ restoredPaths: string[] }>([name, presentationId]);
  if (!result.ok) {
    throw new SlidraError(result.message);
  }
  if (!Array.isArray(result.data?.restoredPaths)) {
    throw new SlidraError(`${name} returned malformed data`);
  }
  return { restoredPaths: result.data.restoredPaths };
}

const runUndo = (id: string): Promise<{ restoredPaths: string[] }> => runCommandRestoringPaths("undo", id);
const runRedo = (id: string): Promise<{ restoredPaths: string[] }> => runCommandRestoringPaths("redo", id);

/**
 * `POST /api/undo` and `POST /api/redo` (T5, NOOP-93/#110). Both are human
 * editing requests in the single-editor-lock sense (plan §4.1): refused
 * with 409 while the agent holds the floor, run unconditionally otherwise
 * — a thrown `SlidraError` on an empty stack is relayed here as 400 with
 * the command's own message verbatim rather than a silent 200.
 */
/** Resolves to whether the undo/redo actually wrote to the deck (NOOP-422) — `serve.ts`'s route uses this to decide whether to schedule a continuous-save write-back, same convention as `handleCommandPost`/`handleAssetPost`. */
async function handleUndoRedoPost(
  editingLock: EditingLock,
  presentationId: string,
  run: (id: string) => Promise<{ restoredPaths: string[] }>,
  res: ServerResponse,
): Promise<boolean> {
  if (editingLock.getState() === "agent") {
    sendJson(res, 409, { error: new EditingLockConflictError().message });
    return false;
  }
  try {
    const result = await run(presentationId);
    sendJson(res, 200, result);
    return true;
  } catch (error) {
    sendJson(res, 400, { error: error instanceof SlidraError ? error.message : "Could not complete the operation" });
    return false;
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
        throw new SlidraError("Server is shutting down");
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
      sendJson(res, 500, { error: "Failed to read static file" });
      return;
    }
    if (isRoot) {
      // index.html itself is missing: the frontend was never built at all.
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
