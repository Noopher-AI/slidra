// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type * as acp from "@agentclientprotocol/sdk";
import { SlidraError } from "../slidra/errors.js";
import { ADAPTER_SPECS, adapterSpecFor, resolveAdapterConfig, type AgentKind } from "./adapters.js";
import { AgentChatSession, type AgentAdapterConfig, type AgentModel, type AgentModelChoice, type ChatStreamSend } from "./session.js";
import { ChatLog } from "./chat-log.js";
import type { EditingLock } from "../editing-lock.js";
import { probeLogin, spawnCommandRunner, type CommandRunner, type ProbeResult } from "./probe.js";
import { writeAgentModel, writeAgentSelection } from "./settings.js";
import { getActiveLauncher } from "../sandbox/launcher.js";
import { getShimConfig } from "../sandbox/shim-config.js";
import path from "node:path";
import type { WorkbenchPolicy } from "../policy/types.js";

/** `AgentStatus.writeIsolation` (AC7): whether this server's write sandbox is actually enforcing, and why not when it isn't. */
export interface WriteIsolationStatus {
  active: boolean;
  /** Non-null exactly when `active` is false — mirrors `SandboxLauncher.degradedReason`'s own invariant. */
  reason: string | null;
}

/** Where the currently-selected agent kind came from (NOOP-230 §4.3). */
export type AgentSource = "cli" | "settings" | "none";

/** Only two states — deliberately no `not-installed` (§7.3): every adapter ships with the package. */
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
  /** Every supported agent, in `ADAPTER_SPECS`'s order — regardless of which is `current`. */
  agents: AgentCard[];
  /**
   * #303: true whenever there is something Stop can stop — a turn in
   * flight, a message queued behind it, or an adapter handshake on its way
   * to one. A tab loaded mid-turn shows Stop from this, not from the next
   * `chat-chunk`. False with no session.
   */
  turnRunning: boolean;
  /**
   * The model the current session runs on, as the adapter reported it at
   * `session/new` (`AgentChatSession.getModel`). Null when there is no
   * session, or when the adapter reports no model state at all — the chat
   * panel then simply shows nothing rather than guessing a name.
   */
  model: AgentModel | null;
  /** `model`'s id, for the picker's selected row; null whenever `model` is. */
  modelId: string | null;
  /** Every model the current session can switch to (`POST /api/agent/model`); `[]` with no session or an adapter that reports none. */
  models: readonly AgentModelChoice[];
  /** AC7: whether the write sandbox is actually enforcing right now, and why not when it isn't (forced off, Windows, or a dependency/init failure). */
  writeIsolation: WriteIsolationStatus;
}

/** Thrown by `select()` while the agent holds the editing floor (T5) — reuses that conflict's own wording. */
export class AgentSwitchLockedError extends SlidraError {
  constructor() {
    super("The agent is currently editing, please wait.");
  }
}

export interface AgentManagerOptions {
  /** Null exactly while `serve` has no deck bound (NOOP-433) — `retarget()` is how this changes later. */
  presentationId: string | null;
  editingLock: EditingLock;
  /** The workbench's policy (NOOP-617) — passed straight through to every `AgentChatSession` this manager builds, never inspected here. */
  policy: WorkbenchPolicy;
  /** The deployed agent working directory (NOOP-231) every session runs in. Null in lockstep with `presentationId`. */
  workdir: string | null;
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
  /** Fired after `setModel()` actually switched the live session — rides the same SSE fan-out as `agent-changed`. */
  onModelChanged?: (payload: { kind: AgentKind; modelId: string; name: string }) => void;
  /** The models picked earlier (settings.json), applied to every new session of that kind. */
  initialModels?: Partial<Record<AgentKind, string>>;
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
  /** Mutable — `retarget()` (NOOP-433) is how these change after construction; both are null in lockstep, exactly while no deck is bound. */
  private presentationId: string | null;
  private workdir: string | null;
  private readonly editingLock: EditingLock;
  private readonly policy: WorkbenchPolicy;
  private readonly runCommand: CommandRunner;
  private readonly resolveAdapter: (kind: AgentKind) => AgentAdapterConfig;
  private readonly onAgentChanged?: (payload: { kind: AgentKind; label: string }) => void;
  private readonly onModelChanged?: (payload: { kind: AgentKind; modelId: string; name: string }) => void;
  private readonly preferredModels: Partial<Record<AgentKind, string>>;
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

  /**
   * Persists the conversation into the open deck's own file — one instance
   * per bound deck, `retarget()`'d (never rebuilt) across a session swap,
   * since the conversation it records outlives any one `AgentChatSession`
   * (§7 decision 3). `undefined` in lockstep with `presentationId`/
   * `workdir`: no deck bound, nothing to persist into.
   */
  private chatLog: ChatLog | undefined;
  /** Detaches the internal chat-log-recording subscription from whichever session is currently live — re-pointed alongside `detachFromSession`, never touched by `externalListeners`. */
  private detachChatLogFromSession: (() => void) | undefined;

  constructor(options: AgentManagerOptions) {
    this.presentationId = options.presentationId;
    this.editingLock = options.editingLock;
    this.policy = options.policy;
    this.workdir = options.workdir;
    this.runCommand = options.runCommand ?? spawnCommandRunner;
    this.resolveAdapter = options.resolveAdapter ?? resolveAdapterConfig;
    this.onAgentChanged = options.onAgentChanged;
    this.onModelChanged = options.onModelChanged;
    this.preferredModels = { ...options.initialModels };
    this.assumeLoggedIn = options.assumeLoggedIn ?? new Set();

    this.current = options.initial.kind;
    this.source = options.initial.source;
    this.chatLog = this.presentationId !== null ? new ChatLog(this.presentationId) : undefined;

    if (this.current !== null) {
      this.session = this.maybeBuildSession(this.current);
      this.rewireSession(this.session);
    }
  }

  /** `buildSession`, but only when a deck is actually bound (NOOP-433) — a kind can be selected with no deck open, and that must leave `session` undefined rather than construct one with a null presentation id. */
  private maybeBuildSession(kind: AgentKind): AgentChatSession | undefined {
    if (this.presentationId === null || this.workdir === null) return undefined;
    return this.buildSession(this.presentationId, this.workdir, kind);
  }

  private buildSession(presentationId: string, workdir: string, kind: AgentKind): AgentChatSession {
    const config = this.resolveAdapter(kind);
    // NOOP-425 D5/D6: every spawned agent reaches `slidra` through the CLI
    // sandbox's shim, never a real binary on the ambient PATH — prepending
    // `<sandboxRoot>/bin` (workdir's own parent; `agent/workdir.ts`'s
    // `agentWorkdirTarget` always deploys to `<sandboxRoot>/<presentationId>`)
    // is what makes the agent's shell resolve `slidra` to the wrapper there.
    // Built here rather than in `agent/session.ts` (which may only be
    // touched at its two plan-authorized call sites) since this is the one
    // place that already has `workdir` in hand before the session exists.
    const shimConfig = getShimConfig();
    const shimBinDir = path.join(path.dirname(workdir), "bin");
    const env: Record<string, string> = {
      ...config.env,
      PATH: `${shimBinDir}${path.delimiter}${config.env?.PATH ?? process.env.PATH ?? ""}`,
      ...(shimConfig ? { SLIDRA_SHIM_TOKEN: shimConfig.token, SLIDRA_SHIM_BASE_URL: shimConfig.baseUrl } : {}),
    };
    return new AgentChatSession(
      { ...config, env },
      presentationId,
      this.editingLock,
      workdir,
      this.policy,
      this.preferredModels[kind] ?? null,
    );
  }

  /** Forwards one session's events to every currently attached `/api/chat/stream` listener. */
  private readonly forwardToExternal: ChatStreamSend = (event, data) => {
    for (const send of this.externalListeners) send(event, data);
  };

  /**
   * Mirrors one session's turn events into `chatLog` — a second,
   * independent `attachStream` subscription alongside `forwardToExternal`
   * (session.ts's `EventEmitter` supports any number of listeners), so
   * persistence never depends on whether a browser tab happens to be
   * connected to `/api/chat/stream` right now. `chat-notice`/`chat-error`
   * are deliberately not recorded (§2 scope: only `author`/`agent`/
   * `command`/`divider` are facts about the presentation, not about one
   * browser connection).
   */
  private readonly recordToChatLog: ChatStreamSend = (event, data) => {
    const log = this.chatLog;
    if (!log) return;
    switch (event) {
      case "chat-chunk": {
        const { text } = data as { text: string };
        log.recordAgentChunk(text);
        return;
      }
      case "chat-command": {
        const { toolCallId, command, status, cli } = data as { toolCallId: string; command: string; status: acp.ToolCallStatus; cli: boolean };
        log.recordCommand(toolCallId, command, status, cli);
        return;
      }
      case "chat-command-update": {
        const { toolCallId, status, output, blocked } = data as { toolCallId: string; status: acp.ToolCallStatus; output?: string; blocked?: true };
        log.recordCommandUpdate(toolCallId, { status, ...(output === undefined ? {} : { output }), ...(blocked ? { blocked } : {}) });
        return;
      }
      case "chat-done":
      case "chat-error":
        log.endTurn();
        return;
      default:
        return;
    }
  };

  /** Re-points the internal forwarding subscription at `nextSession` (or nothing, if undefined). External listeners are never touched — this is the whole point of the facade (§4.5). */
  private rewireSession(nextSession: AgentChatSession | undefined): void {
    this.detachFromSession?.();
    this.detachFromSession = nextSession?.attachStream(this.forwardToExternal);
    this.detachChatLogFromSession?.();
    this.detachChatLogFromSession = nextSession?.attachStream(this.recordToChatLog);
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

  /** Always reruns every probe in parallel (total time bounded by one probe's own timeout) and refreshes the cache. */
  async probe(): Promise<AgentStatus> {
    const results = await Promise.all(ADAPTER_SPECS.map(async (spec) => [spec.kind, await this.probeOne(spec.kind)] as const));
    this.probeCache = new Map<AgentKind, ProbeResult>(results);
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
      model: this.session?.getModel() ?? null,
      modelId: this.session?.getModelId() ?? null,
      models: this.session?.getModelChoices() ?? [],
      writeIsolation: {
        active: getActiveLauncher()?.active ?? false,
        reason: getActiveLauncher()?.degradedReason ?? "write isolation has not been initialized for this server",
      },
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
      this.chatLog?.markUnfinishedInterrupted();
      await previousSession.dispose();
    }
    const nextSession = this.maybeBuildSession(kind);
    this.session = nextSession;
    this.current = kind;
    this.source = "settings";
    this.rewireSession(nextSession);

    const spec = adapterSpecFor(kind);
    this.onAgentChanged?.({ kind, label: spec.label });
    // §7 decision 5: only when there was a live conversation to switch
    // FROM — the very first agent pick (no `previousSession`) has no prior
    // thread to mark the boundary of.
    if (previousSession && this.chatLog) {
      const text = this.buildDividerText("switch", spec.label);
      this.chatLog.recordDivider(text);
      this.forwardToExternal("chat-divider", { text });
    }

    return this.status();
  }

  /**
   * The divider text inserted into the conversation on an agent switch or
   * "New chat" reset (§7 decisions 4/5) — built here, not in the browser
   * (`App.tsx` used to compose "Switched to X..." itself), so the exact
   * same text is what gets persisted to `chat_history` and what every
   * connected tab sees. Always names `slidra chat-history` (AC4's own
   * wording requirement) — a fresh session has no memory of anything above
   * this line, and this is how it (or the author, reading back later) finds
   * it again.
   */
  private buildDividerText(kind: "switch" | "new-chat", label?: string): string {
    const start =
      kind === "switch"
        ? `Switched to ${label}. It will handle messages from here.`
        : "Started a new conversation.";
    return `${start} Above is the conversation before it joined — the agent has no memory of it; it can read it back with \`slidra chat-history\` if it needs to.`;
  }

  /**
   * Starts a fresh conversation with the same agent: tears the current ACP
   * session down and builds a new one in its place. The adapter process,
   * its `session/new`, and the editing contract all happen again, so the agent
   * begins with no memory of the previous turns — the server side of the
   * chat panel's "new session" button.
   *
   * Refused while the agent holds the editing floor, for the same reason
   * `select()` is: killing the adapter mid-edit would strand a half-written
   * undo group.
   */
  async newSession(): Promise<AgentStatus> {
    if (this.editingLock.getState() === "agent") {
      throw new AgentSwitchLockedError();
    }
    // Covers both "no kind selected" and "a kind is selected but no deck is
    // open" (NOOP-433) — `!this.session` alone already catches the second
    // case, `this.current === null` keeps the message accurate for the
    // first. Same reused message, same 409 path, for either reason.
    if (this.current === null || !this.session) {
      throw new SlidraError("No agent selected, there is no conversation to restart");
    }

    const previousSession = this.session;
    if (previousSession) {
      this.chatLog?.markUnfinishedInterrupted();
      await previousSession.dispose();
    }
    const nextSession = this.maybeBuildSession(this.current);
    this.session = nextSession;
    this.rewireSession(nextSession);

    if (this.chatLog) {
      const text = this.buildDividerText("new-chat");
      this.chatLog.recordDivider(text);
      this.forwardToExternal("chat-divider", { text });
    }

    return this.status();
  }

  /** Establishes the current agent's session ahead of the first message (`POST /api/agent/session`), so `status().models` fills in. */
  async warmSession(): Promise<AgentStatus> {
    if (!this.session) {
      throw new SlidraError("No agent selected, cannot create a conversation");
    }
    await this.session.warm();
    return this.status();
  }

  /**
   * Switches the current session's model and remembers the pick for this
   * kind (settings.json), so a later "new session", reconnect or restart
   * comes back on the same model. Throws `SlidraError` when no agent is
   * selected, mid-turn, or for a model the adapter does not offer.
   */
  async setModel(modelId: string): Promise<AgentStatus> {
    if (!this.session || this.current === null) {
      throw new SlidraError("No agent selected, cannot switch model");
    }
    const kind = this.current;
    await this.session.setModel(modelId);
    this.preferredModels[kind] = modelId;
    await writeAgentModel(kind, modelId);
    const name = this.session.getModel()?.name ?? modelId;
    this.onModelChanged?.({ kind, modelId, name });
    return this.status();
  }

  /**
   * Sends the author's message on the current session. Throws if no agent
   * is selected — callers must gate with a 409 first (§4.4). `displayText`
   * (e.g. the "(No message entered...)" placeholder) is what gets
   * persisted as the author's own entry when given — the raw `text` sent to
   * the agent otherwise (§7 decision 8).
   */
  sendMessage(text: string, displayText?: string): void {
    if (!this.session) {
      throw new SlidraError("No agent selected, cannot send a message");
    }
    this.chatLog?.recordAuthor(text, displayText);
    this.session.sendMessage(text);
  }

  /** #303: stops the current session — the turn in flight plus every message queued behind it (see `AgentChatSession.cancel`). Throws when no agent is selected or there is nothing to stop. */
  async cancel(): Promise<void> {
    if (!this.session) {
      throw new SlidraError("No agent selected, there is no turn to stop");
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
      this.chatLog?.markUnfinishedInterrupted();
      await this.session.dispose();
    }
    await this.chatLog?.flush();
  }

  /**
   * Re-points this manager at a different deck (NOOP-433's `unbind`/`bind`),
   * or at none. The current session (if any) is always disposed first —
   * its `presentationId`/`workdir` belong to the deck being left — then a
   * fresh one is built only when both a kind is selected and `next` is not
   * null (`maybeBuildSession`'s own rule); `externalListeners`
   * (`/api/chat/stream` connections) are never touched, only re-pointed by
   * `rewireSession`, exactly like `select()`/`newSession()` above.
   */
  async retarget(next: { id: string; workdir: string } | null): Promise<void> {
    const previousSession = this.session;
    if (previousSession) {
      this.chatLog?.markUnfinishedInterrupted();
      await previousSession.dispose();
    }
    // The conversation this deck (if any) still owed a write is flushed
    // before this manager stops pointing at it — `ChatLog.retarget` does
    // that internally; a deck that was never bound (`chatLog` still
    // `undefined`) simply gets a fresh one for the incoming deck.
    if (this.chatLog) {
      if (next) {
        await this.chatLog.retarget(next.id);
      } else {
        await this.chatLog.flush();
        this.chatLog = undefined;
      }
    } else if (next) {
      this.chatLog = new ChatLog(next.id);
    }
    this.presentationId = next?.id ?? null;
    this.workdir = next?.workdir ?? null;
    const nextSession = this.current !== null ? this.maybeBuildSession(this.current) : undefined;
    this.session = nextSession;
    this.rewireSession(nextSession);
  }
}
