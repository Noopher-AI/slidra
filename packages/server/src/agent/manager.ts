import type * as acp from "@agentclientprotocol/sdk";
import { CoMotionError } from "../comotion/errors.js";
import { ADAPTER_SPECS, adapterSpecFor, resolveAdapterConfig, type AgentKind } from "./adapters.js";
import { AgentChatSession, type AgentAdapterConfig, type ChatStreamSend } from "./session.js";
import type { EditingLock } from "../editing-lock.js";
import { probeLogin, spawnCommandRunner, type CommandRunner, type ProbeResult } from "./probe.js";
import { writeAgentSelection } from "./settings.js";

/** Where the currently-selected agent kind came from (NOOP-230 §4.3). */
export type AgentSource = "cli" | "settings" | "none";

/** Only two states — deliberately no `not-installed` (§7.3): both adapters always ship with the package. */
export type AgentAvailability = "available" | "unauthenticated";

export interface AgentCard {
  kind: AgentKind;
  label: string;
  status: AgentAvailability;
  /** Always present, whether or not the agent is currently logged in (F2's copy button needs it either way). */
  loginCommand: string;
  /** Present only when the probe itself could not positively confirm ordinary logged-out state — see `probe.ts`. */
  detail?: string;
}

export interface AgentStatus {
  current: AgentKind | null;
  source: AgentSource;
  /** Always both agents, in `ADAPTER_SPECS`'s order — regardless of which is `current`. */
  agents: AgentCard[];
  /**
   * #303: true whenever there is something Stop can stop — a turn in
   * flight, a message queued behind it, or an adapter handshake on its way
   * to one. A tab loaded mid-turn shows Stop from this, not from the next
   * `chat-chunk`. False with no session.
   */
  turnRunning: boolean;
}

/** Thrown by `select()` while the agent holds the editing floor (T5) — reuses that conflict's own wording. */
export class AgentSwitchLockedError extends CoMotionError {
  constructor() {
    super("agent 正在編輯中，請稍候");
  }
}

export interface AgentManagerOptions {
  presentationId: string;
  editingLock: EditingLock;
  /** The deployed agent working directory (NOOP-231) every session runs in. */
  workdir: string;
  /** What `serve` started with — the queryable "why is `current` what it is" (§4.3's `source` field). */
  initial: { kind: AgentKind | null; source: AgentSource };
  /** Injected for tests — see `probe.ts`. Defaults to actually spawning `claude`/`codex`. */
  runCommand?: CommandRunner;
  /**
   * Builds the `AgentAdapterConfig` to spawn for `kind`. Defaults to
   * `resolveAdapterConfig` (the real, package-resolved adapters). `serve.ts`
   * overrides this to preserve `ServeOptions.agent`'s existing
   * "already-selected adapter" compatibility path (§3.5) and tests override
   * it to point both kinds at fake ACP fixtures.
   */
  resolveAdapter?: (kind: AgentKind) => AgentAdapterConfig;
  /** Fired only when `select()` actually swaps to a different kind (§4.4's `agent-changed` event). */
  onAgentChanged?: (payload: { kind: AgentKind; label: string }) => void;
  /**
   * Skips the real login probe for these kinds — `status()`/`probe()`
   * always report them as logged in, without spawning anything.
   *
   * Back-compat seam for `ServeOptions.agent` (serve.ts's own docstring):
   * every pre-NOOP-230 test suite and the e2e harness hand a directly-built
   * `AgentAdapterConfig` (often pointed at a fake ACP fixture) straight
   * through as "the adapter to use" — a concept that predates login
   * probing entirely and has no real "logged in" state to check. Without
   * this, `/api/chat`'s new gate would 409 every one of those suites the
   * moment the *real* `claude`/`codex` CLI on whatever machine runs the
   * tests happens to report logged out (verified: it does, in this repo's
   * own sandbox). `serve.ts` sets this only for `ServeOptions.agent`'s own
   * kind; `cli.ts`'s production path never sets it, so real serve always
   * probes real CLIs.
   */
  assumeLoggedIn?: ReadonlySet<AgentKind>;
}

/**
 * Owns the agent's whole lifecycle for one `serve` process (NOOP-230): which
 * kind is current, whether it is logged in, and the one live
 * `AgentChatSession` — including swapping that session out when the user
 * picks a different agent mid-run. `serve.ts` talks to this instead of
 * constructing `AgentChatSession` directly; the HTTP layer's `/api/agent*`
 * routes and the `/api/chat` pre-gate (§4.4) are thin wrappers around
 * `status()`/`probe()`/`select()`/`sendMessage()` here.
 */
export class AgentManager {
  private readonly presentationId: string;
  private readonly editingLock: EditingLock;
  private readonly workdir: string;
  private readonly runCommand: CommandRunner;
  private readonly resolveAdapter: (kind: AgentKind) => AgentAdapterConfig;
  private readonly onAgentChanged?: (payload: { kind: AgentKind; label: string }) => void;
  private readonly assumeLoggedIn: ReadonlySet<AgentKind>;

  private current: AgentKind | null;
  private source: AgentSource;
  private session: AgentChatSession | undefined;

  /** Undefined until the first probe; `status()` uses this as-is once populated — see its own docstring. */
  private probeCache: Map<AgentKind, ProbeResult> | undefined;

  /** Detaches the internal forwarding subscription from whichever session is currently live. */
  private detachFromSession: (() => void) | undefined;
  /** Every `/api/chat/stream` connection's send function — persists across a session swap (§4.5). */
  private readonly externalListeners = new Set<ChatStreamSend>();
  /** Detaches the internal `available-commands` subscription from whichever session is currently live. */
  private detachCommandsFromSession: (() => void) | undefined;
  /** Listeners for "the agent reported a fresh command list" — persists across a session swap, like `externalListeners`. */
  private readonly commandsListeners = new Set<() => void>();

  constructor(options: AgentManagerOptions) {
    this.presentationId = options.presentationId;
    this.editingLock = options.editingLock;
    this.workdir = options.workdir;
    this.runCommand = options.runCommand ?? spawnCommandRunner;
    this.resolveAdapter = options.resolveAdapter ?? resolveAdapterConfig;
    this.onAgentChanged = options.onAgentChanged;
    this.assumeLoggedIn = options.assumeLoggedIn ?? new Set();

    this.current = options.initial.kind;
    this.source = options.initial.source;

    if (this.current !== null) {
      this.session = this.buildSession(this.current);
      this.rewireSession(this.session);
    }
  }

  private buildSession(kind: AgentKind): AgentChatSession {
    const config = this.resolveAdapter(kind);
    return new AgentChatSession(config, this.presentationId, this.editingLock, this.workdir);
  }

  /** Forwards one session's events to every currently attached `/api/chat/stream` listener. */
  private readonly forwardToExternal: ChatStreamSend = (event, data) => {
    for (const send of this.externalListeners) send(event, data);
  };

  /** Re-points the internal forwarding subscription at `nextSession` (or nothing, if undefined). External listeners are never touched — this is the whole point of the facade (§4.5). */
  private rewireSession(nextSession: AgentChatSession | undefined): void {
    this.detachFromSession?.();
    this.detachFromSession = nextSession?.attachStream(this.forwardToExternal);
    // `available-commands` is session-level, not turn-scoped, so it rides its
    // own subscription rather than `attachStream` (see the session's own
    // docstring). Re-pointed here for the same reason the stream is: the `/`
    // list must keep updating across a session swap.
    this.detachCommandsFromSession?.();
    this.detachCommandsFromSession = undefined;
    if (nextSession) {
      const forward = () => {
        for (const listener of this.commandsListeners) listener();
      };
      nextSession.on("available-commands", forward);
      this.detachCommandsFromSession = () => nextSession.off("available-commands", forward);
    }
  }

  /**
   * Cached status: probes once (on the very first call) and reads the cache
   * on every call after that. Deliberately does not reprobe on every call —
   * a chat message must never spawn two more subprocesses just to render
   * status (§7.7). Use `probe()` to force a fresh read.
   */
  async status(): Promise<AgentStatus> {
    if (!this.probeCache) {
      return this.probe();
    }
    return this.buildStatus();
  }

  /** Always reruns both probes (in parallel — total time bounded by one probe's own timeout) and refreshes the cache. */
  async probe(): Promise<AgentStatus> {
    const [claude, codex] = await Promise.all([this.probeOne("claude"), this.probeOne("codex")]);
    this.probeCache = new Map<AgentKind, ProbeResult>([
      ["claude", claude],
      ["codex", codex],
    ]);
    return this.buildStatus();
  }

  /** See `assumeLoggedIn`'s own docstring for why a kind may skip the real probe entirely. */
  private probeOne(kind: AgentKind): Promise<ProbeResult> {
    if (this.assumeLoggedIn.has(kind)) {
      return Promise.resolve({ loggedIn: true });
    }
    return probeLogin(kind, this.runCommand);
  }

  private buildStatus(): AgentStatus {
    const cache = this.probeCache;
    return {
      current: this.current,
      source: this.source,
      turnRunning: this.session?.isBusy() ?? false,
      agents: ADAPTER_SPECS.map((spec) => {
        const result = cache?.get(spec.kind);
        const card: AgentCard = {
          kind: spec.kind,
          label: spec.label,
          status: result?.loggedIn ? "available" : "unauthenticated",
          loginCommand: spec.loginCommand,
        };
        if (result?.detail !== undefined) card.detail = result.detail;
        return card;
      }),
    };
  }

  /**
   * Persists `kind` as the user's selection and, if it differs from
   * `current`, swaps the live session (§4.3's table). Login status is never
   * required — selecting and being logged in are separate concerns (§7.5).
   *
   * Order matters (§4.3): the settings write happens first (a failure here
   * leaves everything else untouched), then — only when the kind actually
   * changes — the old session is disposed before the new one is built, so a
   * disposed-but-not-yet-replaced window never has two live sessions.
   */
  async select(kind: AgentKind): Promise<AgentStatus> {
    if (this.editingLock.getState() === "agent") {
      throw new AgentSwitchLockedError();
    }

    await writeAgentSelection(kind);

    if (kind === this.current) {
      this.source = "settings";
      return this.status();
    }

    const previousSession = this.session;
    if (previousSession) {
      await previousSession.dispose();
    }
    const nextSession = this.buildSession(kind);
    this.session = nextSession;
    this.current = kind;
    this.source = "settings";
    this.rewireSession(nextSession);

    const spec = adapterSpecFor(kind);
    this.onAgentChanged?.({ kind, label: spec.label });

    return this.status();
  }

  /** Sends the author's message on the current session. Throws if no agent is selected — callers must gate with a 409 first (§4.4). */
  sendMessage(text: string): void {
    if (!this.session) {
      throw new CoMotionError("尚未選擇 agent，無法傳送訊息");
    }
    this.session.sendMessage(text);
  }

  /** #303: stops the current session — the turn in flight plus every message queued behind it (see `AgentChatSession.cancel`). Throws when no agent is selected or there is nothing to stop. */
  async cancel(): Promise<void> {
    if (!this.session) {
      throw new CoMotionError("尚未選擇 agent，沒有可以停止的回合");
    }
    await this.session.cancel();
  }

  /** Attaches one SSE stream's `send` to whichever session is (or later becomes) current; returns a detach function. */
  attachStream(send: ChatStreamSend): () => void {
    this.externalListeners.add(send);
    return () => {
      this.externalListeners.delete(send);
    };
  }

  /** The kind currently selected, or null when none is — the `/` command list needs it to resolve the user skill directory. */
  currentKind(): AgentKind | null {
    return this.current;
  }

  /** The current session's latest agent-reported command list; empty when no agent is selected. */
  getReportedCommands(): readonly acp.AvailableCommand[] {
    return this.session?.getReportedCommands() ?? [];
  }

  /** Subscribes to "the agent reported a fresh command list", across session swaps; returns an unsubscribe function. */
  onAvailableCommands(listener: () => void): () => void {
    this.commandsListeners.add(listener);
    return () => {
      this.commandsListeners.delete(listener);
    };
  }

  /** Tears down the current session, if any. Idempotent — `AgentChatSession.dispose()` itself already is. */
  async dispose(): Promise<void> {
    this.rewireSession(undefined);
    if (this.session) {
      await this.session.dispose();
    }
  }
}
