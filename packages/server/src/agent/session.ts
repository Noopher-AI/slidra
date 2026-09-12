import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { SlidraError, SlidraNotFoundError } from "../slidra/errors.js";
import { readPresentationText } from "../slidra/reads.js";
import { beginHistoryGroup, endHistoryGroup } from "../slidra/history-group.js";
import { runJsonCommand } from "../slidra/command.js";
import type { AgentKind } from "./adapters.js";
import { buildEditorialBrief } from "./brief.js";
import { isSlidraCommand } from "./command-allowlist.js";
import { hintForBlockedCommand } from "./command-hints.js";
import { touchesProtectedPath, type ProtectedPaths } from "./protected-paths.js";
import { classifyAgentReadPath, readAgentWorkdirFile } from "./workdir.js";
import { readProjectsRegistry, resolveSlidraHome } from "../slidra/home.js";
import type { EditingLock } from "../editing-lock.js";

/**
 * `fs/write_text_file` is always refused (ADR-0004, first layer). The
 * message names the one command that exists for editing text today, so an
 * agent that tries to write directly can correct itself on the very next
 * turn (user story 32) instead of merely learning that it failed.
 */
/** Sent in place of 【作者的訊息】 when the author submitted no text but has comments pinned. */
const NO_MESSAGE_INSTRUCTION = "作者沒有輸入訊息，只送出上面這些釘選的留言——請依這些留言處理這份簡報。";

/** Refused turn: no text typed and nothing pinned, so there is nothing to act on. */
const EMPTY_MESSAGE_MESSAGE = "訊息內容不可為空（沒有輸入文字，也沒有釘選的留言）";

const WRITE_REFUSED_MESSAGE =
  "Slidra 不允許 agent 直接寫入檔案，這個方法一律會被拒絕。若要修改文字內容，請改執行 `slidra text set` 命令。";

/** A comment read back out with the slide it lives on — `comment list <id> --json`'s (no slide-path) output shape. */
interface SlideCommentWithPath {
  id: string;
  target: string;
  author: string;
  created: string;
  text: string;
  slidePath: string;
}

/** `comment list <id> --json` (no slide-path) — every comment across the whole presentation, plan §3.7. */
async function listAllComments(presentationId: string): Promise<SlideCommentWithPath[]> {
  const result = await runJsonCommand<{ comments: SlideCommentWithPath[] }>(["comment", "list", presentationId]);
  if (!result.ok) {
    throw new SlidraError(result.message);
  }
  if (!Array.isArray(result.data?.comments)) {
    throw new SlidraError("comment list 回傳的資料格式錯誤");
  }
  return result.data.comments;
}

/**
 * Builds the `/api/chat` prompt's comment-context prefix, or `null` when
 * there are no comments — a message with nothing pinned to it must go out
 * byte-identical to what the author typed, guarded by `chat.test.ts`'s
 * existing "editorial brief" assertion. A standalone pure function, not a
 * private method, so a unit test can verify the exact format without
 * spinning up an ACP session.
 */
export function buildCommentContext(comments: readonly SlideCommentWithPath[]): string | null {
  if (comments.length === 0) return null;
  const lines = comments.map((comment) => `${comment.slidePath} ${comment.target} ${comment.id}：${comment.text}`);
  return (
    "【作者釘選的留言】\n" +
    "以下是作者釘在這份簡報上的留言，隨這則訊息一起給你。每一行的格式是「投影片路徑 目標 留言識別碼」，冒號之後是留言原文；目標是元素識別碼，或 page（代表整頁）。\n" +
    lines.join("\n")
  );
}

/**
 * Everything needed to spawn one ACP adapter subprocess. Real production
 * code builds this from `resolveAdapterConfig()` (Node plus the packaged
 * adapter entry point). Tests build it by pointing `command`
 * at `process.execPath` and `args` at the fake ACP agent fixture — the same
 * shape, so `AgentChatSession` cannot tell the difference.
 */
export interface AgentAdapterConfig {
  kind: AgentKind;
  /** Human-readable name used in login-prompt and error text. */
  label: string;
  command: string;
  args?: string[];
  /**
   * Extra environment variables merged over the inherited `process.env`.
   * Production code never sets this — real adapters read their own
   * config/auth state from the environment they were launched in. Tests
   * use it to hand the fake ACP agent fixture its per-test script
   * (`FAKE_AGENT_CONFIG`) and log file (`FAKE_AGENT_LOG`) without mutating
   * the test process's own `process.env`.
   */
  env?: Record<string, string>;
}

/**
 * JSON-RPC code `RequestError.authRequired()` carries (see the SDK's
 * `acp.RequestError`). Re-declared here because the SDK exposes it only as
 * a response-building factory, not as an importable constant.
 */
const AUTH_REQUIRED_CODE = -32000;

/**
 * JSON-RPC error codes for the file methods. The SDK's own factories
 * (`RequestError.resourceNotFound()`, `.internalError()`) hardcode English
 * messages, but ADR-0004 requires the existing Traditional-Chinese wording
 * to survive verbatim — so these codes are used with the plain
 * `RequestError` constructor instead. `resourceNotFound`'s own code
 * (-32002) is reused for "genuinely absent" to stay consistent with the
 * SDK's own convention for that case; internal errors reuse JSON-RPC's
 * generic internal-error code (-32603).
 */
const READ_NOT_FOUND_CODE = -32002;
const READ_FAILED_CODE = -32603;
const WRITE_REFUSED_CODE = -32603;

/**
 * `fs/read_text_file` refusal for an absolute `path` that does not fall
 * under the session cwd (fix 3). Deliberately names no path at all — the
 * incoming string is, by definition, a real filesystem path in this branch,
 * and ADR-0004's third layer requires no real path ever appear in an error.
 */
const PATH_OUTSIDE_SESSION_CWD_MESSAGE = "找不到檔案：路徑不在這個工作階段的範圍內";

/**
 * Upper bound on how much of a failed command's own output is relayed to
 * the author (ticket #17). The chat sidebar is a place to see *that* a
 * command failed and why; a command that prints a megabyte of output on
 * the way down would otherwise push the whole conversation off screen.
 * Truncation is announced in the text itself — never silent.
 */
/**
 * Shown in place of the adapter's own wording when the allowlist refused a
 * command. ACP's `session/request_permission` can answer only allow or
 * reject — there is no field to say *why* — so Claude Code renders every
 * refusal as "The user doesn't want to proceed with this tool use", which
 * reads to the author as though they had clicked something. They did not:
 * the rule is hard-coded and the author is never asked (user story 12).
 * This says what actually happened, on the author's side of the screen.
 */
const BLOCKED_COMMAND_MESSAGE =
  "Slidra 擋下了這條命令（不是作者拒絕的）：它直接動到這份簡報的檔案，而簡報只能透過 slidra 命令讀寫。其他不碰簡報檔案的命令不受限制。";

/**
 * Said once when a refused command took the whole turn down with it — see
 * `findRejectOption` for why some adapters leave no other way to refuse.
 * Without it the conversation ends on 「已停止」, which reads as the author's
 * own doing.
 */
/**
 * How many times one author message may be handed back to the agent with
 * advice after a refusal. Two is enough for the case this exists for (the
 * agent reached for `cat`, was told to use the read tool, carried on); an
 * agent still refused after that is not going to be talked round, and the
 * author should see the turn end rather than watch it loop.
 */
const MAX_REFUSAL_CORRECTIONS = 2;

/** What the agent is told after Slidra takes the turn back — see the loop in `runTurn`. */
function refusalCorrectionPrompt(hints: string[]): string {
  const advice = hints.map((hint) => `- ${hint}`).join("\n");
  return [
    "【Slidra 系統訊息｜不是作者說的】",
    "剛剛那條命令沒有執行：它直接動到這份簡報的檔案，而簡報的內容只能透過 `slidra` 命令讀寫（其他不碰簡報檔案的命令不受限制）。",
    "這不是作者拒絕你，也不需要問他——換成下面的做法就可以繼續：",
    advice,
    "請接著把剛才沒做完的部分做完，不要再送同一條被擋下的命令。",
  ].join("\n");
}

/**
 * The author's one line about a refusal. The command itself is not shown —
 * it is the agent's own shell work, which the timeline deliberately leaves
 * out (`relayCommandStart`) — so this says what Slidra did and what it
 * told the agent to do instead.
 */
function refusalNotice(hint: string | undefined): string {
  const head = "Slidra 擋下了 agent 直接動簡報檔案的命令（簡報只能透過 slidra 命令改）";
  return hint === undefined ? `${head}。` : `${head}，並告訴它：${hint}`;
}

const TURN_ABORTED_BY_REFUSAL_MESSAGE =
  "這一輪到此為止：Slidra 擋下了上面那條直接動簡報檔案的命令，而這個 agent 把「拒絕」當成中止整個回合——不是作者按了停止。改用 slidra 命令重新發送即可。";

/** The model a live session runs on, as its adapter reports it at `session/new`. */
export interface AgentModel {
  name: string;
  /** The adapter's own description of that model, when it gives one. */
  detail?: string;
}

/** One model the adapter lets the session switch to — the chat panel's picker rows. */
export interface AgentModelChoice {
  id: string;
  name: string;
  detail?: string;
}

/**
 * Where a session's model list came from, which also decides how a switch
 * is sent back: `claude-code-acp` reports ACP's (experimental) `models`
 * state and takes `session/set_model`; `codex-acp` reports it as the
 * `configOptions` entry whose `category` is `model` and takes
 * `session/set_config_option` instead.
 */
type ModelMechanism = { kind: "models" } | { kind: "config"; configId: string };

/** Events an `AgentChatSession` emits while a user-triggered turn is active. */
interface ChatEvents {
  "chat-chunk": (payload: { text: string }) => void;
  "chat-done": (payload: { stopReason: string }) => void;
  "chat-error": (payload: { message: string }) => void;
  /** A command the agent has started running — `command` verbatim from ACP's `rawInput.command`. */
  /**
   * A command the agent is about to run. `cli` says whether it is a
   * `slidra` invocation — the only kind that carries a status the author
   * is meant to read (see `relayCommandStart`). A command with `cli: false`
   * is shown once and never followed by `chat-command-update`.
   */
  "chat-command": (payload: { toolCallId: string; command: string; status: acp.ToolCallStatus; cli: boolean }) => void;
  /**
   * A status change on a command already relayed by `chat-command`.
   * `output` only ever accompanies a failure. `blocked` marks the one
   * failure that is not the command's own: Slidra's allowlist refused to
   * let it run (see `BLOCKED_COMMAND_MESSAGE`).
   */
  "chat-command-update": (payload: {
    toolCallId: string;
    status: acp.ToolCallStatus;
    output?: string;
    blocked?: true;
  }) => void;
  /**
   * The agent's own `available_commands_update` — a session-level fact, not
   * a turn-scoped one (see `getReportedCommands`'s own comment for why it
   * is stored separately from the other, turn-scoped events above).
   */
  "available-commands": (payload: { commands: readonly acp.AvailableCommand[] }) => void;
  /** A line the server itself has to say (not the agent) — e.g. how many queued messages Stop threw away. */
  "chat-notice": (payload: { text: string }) => void;
}

/**
 * The shape `AgentChatSession.attachStream` accepts — pulled out as its own
 * exported type so `AgentManager` (NOOP-230's session-switching facade,
 * `manager.ts`) can declare the same signature for its own `attachStream`
 * without reaching into `ChatEvents`, which stays unexported.
 */
export type ChatStreamSend = (event: keyof ChatEvents, data: unknown) => void;

/**
 * Drives one ACP adapter subprocess for the lifetime of `slidra serve`.
 *
 * Spawning is lazy (first `sendMessage`), the session is persistent across
 * messages, and the editorial brief is sent as its own, separate
 * `session/prompt` before the author's first message ever goes out — that
 * ordering is `ensureSession()`'s entire job.
 */
export class AgentChatSession extends EventEmitter {
  private readonly config: AgentAdapterConfig;
  /** Opaque id of the presentation this session serves (ADR-0004: the agent itself never sees it). */
  private readonly presentationId: string;
  private child: ChildProcess | undefined;
  private connection: acp.ClientSideConnection | undefined;
  private sessionId: string | undefined;
  /**
   * The deployed product work directory (`deployAgentWorkdir()`'s result),
   * already resolved to its real (symlink-free) form — handed to the agent
   * as its session `cwd` on every attempt, and never removed by this
   * session (its lifetime is `SLIDRA_HOME`'s, not the session's). A
   * conforming ACP agent echoes back an *absolute* path rooted at the cwd
   * it was given — but resolved, not verbatim (confirmed against a real
   * `claude-code-acp` 0.12.6: the cwd sent to `session/new` was
   * `/var/folders/...`, the `path` a subsequent `fs/read_text_file` sent
   * back was `/private/var/folders/...` — macOS resolves that `/var`
   * symlink). Comparing an absolute `path` against an unresolved string
   * would therefore fail on every single real read; comparing against this
   * resolved form is what actually matches.
   */
  private readonly workdirReal: string;
  /**
   * The open presentation's `.slidra` file, read once from the registry
   * when the session is established. Undefined when the registry has no
   * `sourcePath` for this id (a presentation created but never saved out)
   * — `<SLIDRA_HOME>` still covers its live files either way.
   */
  private sourcePath: string | undefined;
  private readyPromise: Promise<void> | undefined;
  /** Serializes turns so two `sendMessage` calls never interleave on one session. */
  private turnQueue: Promise<void> = Promise.resolve();
  /**
   * #303: messages accepted but not yet started, in send order. The queue
   * is a plain array rather than state hidden inside `turnQueue`'s promise
   * chain for one reason: `cancel()` has to be able to *empty* it. Stopping
   * only the turn in flight let the next queued message start the instant
   * the stopped one ended, which reads as "Stop restarted the agent".
   */
  private readonly pendingTurns: string[] = [];
  /** True from the first `sendMessage` until the adapter handshake settles — the window where a turn is coming but `session/prompt` has not been sent yet. */
  private settingUp = false;
  /** True only while relaying updates for a turn the author actually asked for — not for the editorial brief turn. */
  private relayingCurrentTurn = false;
  /**
   * #303: set by `cancel()`, cleared when the next author turn starts. A
   * real `claude-code-acp` answers our `session/prompt` with `cancelled`
   * but its model keeps going for a while, still emitting `session/update`
   * and `session/request_permission` with no prompt in flight (trial 4:
   * 137 chunks and 20 commands after our `chat-done`). Everything that
   * arrives while this is set — or while no turn is running at all — is
   * dropped, and every permission request is answered `cancelled`, so no
   * command can run outside a turn.
   */
  private cancelledUntilNextPrompt = false;
  private droppedOutsideTurn = 0;
  private refusedOutsideTurnLogged = false;
  /** Set at `session/new` from the adapter's own model report (and again on every switch); stays null when it reports none. */
  private model: AgentModel | null = null;
  private modelId: string | null = null;
  private modelChoices: AgentModelChoice[] = [];
  private modelMechanism: ModelMechanism | null = null;
  /**
   * The most recent `available_commands_update` the agent has sent, or `[]`
   * if it has never sent one. Unlike the turn-scoped events above, this
   * arrives outside any turn (typically right after `session/new`, before
   * the editorial brief prompt) and is a standing fact about the session, not
   * something to relay once and forget — `serve.ts` reads it back via
   * `getReportedCommands()` whenever it needs to recompute the `/` list
   * (e.g. serving `GET /api/agent/commands`), not only at the moment it was
   * reported.
   */
  private reportedCommands: readonly acp.AvailableCommand[] = [];
  /**
   * `toolCallId`s already relayed to the author as commands (ticket #17).
   * A `tool_call_update` carries only the id — never `rawInput` again — so
   * without this there is no way to tell an update about a command the
   * author is watching from an update about a tool call that was never
   * shown (a file read, a plan). Cleared at the end of every turn: ids are
   * scoped to the turn that showed them.
   */
  private readonly relayedToolCalls = new Set<string>();
  /**
   * Tool calls this turn whose command the allowlist refused. Kept so the
   * failure the adapter reports for them can be shown to the author in
   * Slidra's own words rather than the adapter's misleading one — same
   * turn scope, and cleared alongside, `relayedToolCalls`.
   */
  private readonly refusedToolCalls = new Set<string>();
  /**
   * This turn's advice for the commands the allowlist refused, keyed by
   * tool call so the author sees it attached to the command it belongs to,
   * and deduplicated on the way out (an agent that tried `cat` three times
   * gets told once). Same turn scope as `refusedToolCalls`.
   */
  private readonly refusalHints = new Map<string, string>();
  private disposed = false;
  /**
   * Rejects whatever ACP call (`initialize`/`newSession`/`prompt`) is
   * currently awaited, set for the duration of that one call by
   * `withInterrupt`. The ACP SDK never settles a pending call on its own
   * when stdio hits EOF or a write fails (fix 1) — this is the only thing
   * that can unblock it, so the child's `error`/`exit` handlers reach for
   * it directly instead of hoping the SDK notices.
   */
  private activeReject: ((error: Error) => void) | undefined;
  /**
   * Bumped once per spawned child, in `establishSession`. A killed child's
   * OS-level `exit` event fires asynchronously, at some indeterminate later
   * time — it is not bound by `turnQueue`'s serialization at all. Without
   * this guard, a *stale* child from an already-superseded attempt could
   * fire `exit` while a brand-new, perfectly healthy attempt is mid-flight
   * and steal its `activeReject`/teardown, poisoning a session that never
   * actually failed. Each child's handlers close over the generation it was
   * spawned for and `handleChildDown` ignores any generation that is no
   * longer current.
   */
  private generation = 0;
  /**
   * Single-editor lock (T5, NOOP-93/#110). Shared with the HTTP routes
   * (`/api/undo`, `/api/redo`, `/api/editing/*`) via `serve.ts` — this
   * session only ever calls `acquireAgent`/`releaseAgent` on it, never
   * inspects the human side directly.
   */
  private readonly editingLock: EditingLock;
  /**
   * True once this turn has acquired `editingLock` and called
   * `beginHistoryGroup` — set on the turn's first command, cleared in
   * `runTurn`'s `finally`. This session is the turn-level group's
   * designated owner: it always calls `endHistoryGroup` unconditionally
   * when the turn ends, regardless of the return value `beginHistoryGroup`
   * gave it (a stale group left open by a crashed prior owner is one it
   * joins and then closes — self-healing). `turnHasEditLock` also tells
   * `finally` whether there is a group/lock to close at all (a turn that
   * only thinks/reads never opens either).
   */
  private turnHasEditLock = false;

  /**
   * The model the author last picked for this adapter kind (settings.json),
   * applied right after `session/new` when the adapter still offers it —
   * a "new session" or a reconnect after a crash keeps the author's choice
   * instead of silently reverting to the adapter's default.
   */
  private readonly preferredModelId: string | null;

  constructor(
    config: AgentAdapterConfig,
    presentationId: string,
    editingLock: EditingLock,
    workdirReal: string,
    preferredModelId: string | null = null,
  ) {
    super();
    this.config = config;
    this.presentationId = presentationId;
    this.editingLock = editingLock;
    this.workdirReal = workdirReal;
    this.preferredModelId = preferredModelId;
  }

  override on<K extends keyof ChatEvents>(event: K, listener: ChatEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof ChatEvents>(event: K, listener: ChatEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  private emitTyped<K extends keyof ChatEvents>(event: K, ...args: Parameters<ChatEvents[K]>): void {
    this.emit(event, ...args);
  }

  /** The model this session runs on, as the adapter named it at `session/new`; null when the adapter reports none. */
  getModel(): AgentModel | null {
    return this.model;
  }

  /**
   * Establishes the ACP session without sending an author message, so the
   * model list (a `session/new` fact) exists before the first message. The
   * editorial brief goes out exactly as it would on the first message; a later
   * message reuses this session. No-op when a session is already live.
   */
  async warm(): Promise<void> {
    await this.ensureSession();
  }

  /** The current model's id, or null when the adapter reports no model state. */
  getModelId(): string | null {
    return this.modelId;
  }

  /** Every model the adapter lets this session switch to; `[]` when it reports none. */
  getModelChoices(): readonly AgentModelChoice[] {
    return this.modelChoices;
  }

  /**
   * Switches the live session to `modelId`. Establishes the session first
   * when no message has been sent yet (the model list only exists once
   * `session/new` has answered), so the picker works before the first
   * message too. Refused mid-turn: the adapter would apply it to a reply
   * already in progress.
   */
  async setModel(modelId: string): Promise<void> {
    if (this.relayingCurrentTurn || this.pendingTurns.length > 0) {
      throw new SlidraError("agent 正在回覆中，等這一輪結束再切換模型");
    }
    await this.ensureSession();
    const choice = this.modelChoices.find((candidate) => candidate.id === modelId);
    if (!choice || !this.modelMechanism || !this.connection || !this.sessionId) {
      throw new SlidraError(`${this.config.label} 沒有這個模型：${modelId}`);
    }
    await this.applyModel(this.connection, this.sessionId, this.modelMechanism, choice);
  }

  /** Sends the switch over whichever request the adapter's mechanism uses, then records the new current model. */
  private async applyModel(
    connection: acp.ClientSideConnection,
    sessionId: string,
    mechanism: ModelMechanism,
    choice: AgentModelChoice,
  ): Promise<void> {
    if (mechanism.kind === "models") {
      await connection.unstable_setSessionModel({ sessionId, modelId: choice.id });
    } else {
      const response = await connection.setSessionConfigOption({ sessionId, configId: mechanism.configId, value: choice.id });
      this.readConfigOptions(response.configOptions);
    }
    this.modelId = choice.id;
    this.model = { name: choice.name, ...(choice.detail ? { detail: choice.detail } : {}) };
  }

  /**
   * Reads the model list out of a `session/new` response. Leaves everything
   * null when the adapter reports neither shape — the chat panel then shows
   * no model rather than a guessed one.
   */
  private readModelState(session: acp.NewSessionResponse): void {
    // `@agentclientprotocol/codex-acp` reports both: `models` is every
    // model × reasoning effort (dozens of rows), the `model` config option
    // is one row per model — the list a person actually picks from. So the
    // config option wins when present; `models` is what `claude-code-acp`
    // sends and the only shape it has.
    this.readConfigOptions(session.configOptions ?? []);
    if (this.modelMechanism || !session.models) return;
    this.modelMechanism = { kind: "models" };
    this.modelChoices = session.models.availableModels.map(toChoice);
    this.setCurrentModel(session.models.currentModelId);
  }

  /** `codex-acp`'s shape: the `configOptions` entry whose `category` is `model`. Grouped options are flattened. */
  private readConfigOptions(options: readonly acp.SessionConfigOption[]): void {
    const option = options.find((candidate) => candidate.category === "model");
    if (!option) return;
    this.modelMechanism = { kind: "config", configId: option.id };
    this.modelChoices = option.options.flatMap((entry) =>
      "options" in entry
        ? entry.options.map((inner) => ({ id: inner.value, name: inner.name, ...(inner.description ? { detail: inner.description } : {}) }))
        : [{ id: entry.value, name: entry.name, ...(entry.description ? { detail: entry.description } : {}) }],
    );
    this.setCurrentModel(option.currentValue);
  }

  private setCurrentModel(id: string): void {
    const current = this.modelChoices.find((candidate) => candidate.id === id);
    this.modelId = current ? id : null;
    this.model = current ? { name: current.name, ...(current.detail ? { detail: current.detail } : {}) } : null;
  }

  /** The agent's most recently reported `available_commands_update`, or `[]` if it has never sent one. */
  getReportedCommands(): readonly acp.AvailableCommand[] {
    return this.reportedCommands;
  }

  /**
   * Sends the author's message. Returns once the message has been queued —
   * callers must not await the whole agent turn (the HTTP handler responds
   * immediately; the reply streams separately over SSE).
   */
  sendMessage(text: string): void {
    this.pendingTurns.push(text);
    this.turnQueue = this.turnQueue.then(() => {
      const next = this.pendingTurns.shift();
      // `cancel()` emptied the queue: this message was dropped on purpose
      // and the author has already been told how many went with it.
      if (next === undefined) return;
      return this.runTurn(next);
    });
    // A rejected turn must not poison the queue for the next message.
    this.turnQueue = this.turnQueue.catch(() => {});
  }

  /**
   * True whenever `cancel()` has something to stop: a turn in flight, a
   * message queued behind it, or an adapter handshake on its way to one.
   * The chat panel shows Stop from this, so every state the author would
   * describe as "it is working" has a working Stop button.
   */
  isBusy(): boolean {
    return this.relayingCurrentTurn || this.pendingTurns.length > 0 || this.settingUp;
  }

  /**
   * #303: sends ACP `session/cancel` for the turn in flight. Per the ACP
   * contract the agent then stops its model requests, aborts tool calls it
   * still controls, flushes pending updates, and answers the original
   * `session/prompt` with `stopReason: "cancelled"` — so the turn ends
   * through `runTurn`'s normal path (`chat-done` carrying that stopReason,
   * history group closed, editing lock released). A `slidra` command
   * the agent had already launched runs to completion on its own (each
   * command is atomic); nothing written so far is rolled back — undo is
   * the author's tool for that, not this.
   *
   * Throws when no author turn is running: cancelling nothing is a caller
   * mistake worth surfacing (a 409 upstream), not a silent no-op.
   */
  async cancel(): Promise<void> {
    // Queued-but-unstarted messages go first and unconditionally: whatever
    // else Stop can or cannot reach, nothing the author has not seen start
    // may start after they pressed it.
    const dropped = this.pendingTurns.length;
    this.pendingTurns.length = 0;

    const turnInFlight = this.relayingCurrentTurn && this.connection !== undefined && this.sessionId !== undefined;
    if (turnInFlight) {
      this.cancelledUntilNextPrompt = true;
      await this.connection!.cancel({ sessionId: this.sessionId! });
    } else if (this.settingUp) {
      // Still shaking hands with the adapter, so there is no `sessionId` to
      // cancel against. Rejecting the awaited call is the only way out;
      // `ensureSession`'s own catch then tears the half-built session down
      // so the next message starts from a clean spawn.
      const reject = this.activeReject;
      this.activeReject = undefined;
      reject?.(new SlidraError(`${this.config.label} 的連線在建立過程中被停止，請重新發送訊息`));
    } else if (dropped === 0) {
      throw new SlidraError("目前沒有進行中的回合可以停止");
    }

    if (dropped > 0) {
      this.emitTyped("chat-notice", {
        text: `已停止；另有 ${dropped} 則尚未開始的訊息一併取消。`,
      });
    }
  }

  /** True when an update or permission request has no author turn to belong to (see `cancelledUntilNextPrompt`). */
  private outsideTurn(): boolean {
    return !this.relayingCurrentTurn || this.cancelledUntilNextPrompt;
  }

  private async runTurn(text: string): Promise<void> {
    try {
      await this.ensureSession();
    } catch (error) {
      this.emitTyped("chat-error", { message: describeError(error) });
      return;
    }

    // [E2.T8]: pinned comments ride along as a context prefix the author
    // never types (§4.4 of the plan) — read fresh every turn, straight off
    // disk, so a comment the agent itself wrote via `comment add` moments
    // ago is included too. A read failure here must not silently fall back
    // to sending the bare message: that would hand the agent a
    // plausible-looking reply built on missing context instead of a loud
    // failure the author can retry.
    let prompt = text;
    try {
      const comments = await listAllComments(this.presentationId);
      const context = buildCommentContext(comments);
      if (context !== null) {
        // An empty message with comments pinned means "do what the pins
        // say" — the pins are the request, so the agent is told exactly
        // that rather than being handed an empty 【作者的訊息】 block to
        // interpret on its own.
        prompt =
          text.trim() === ""
            ? `${context}\n\n${NO_MESSAGE_INSTRUCTION}`
            : `${context}\n\n【作者的訊息】\n${text}`;
      } else if (text.trim() === "") {
        // Nothing typed and nothing pinned: there is no request at all.
        this.emitTyped("chat-error", { message: EMPTY_MESSAGE_MESSAGE });
        return;
      }
    } catch (error) {
      this.emitTyped("chat-error", { message: describeError(error) });
      return;
    }

    this.relayingCurrentTurn = true;
    this.cancelledUntilNextPrompt = false;
    if (this.droppedOutsideTurn > 0) {
      console.warn(`[agent] 上一輪停止後仍收到 ${this.droppedOutsideTurn} 則 session/update，已全部丟棄`);
      this.droppedOutsideTurn = 0;
    }
    this.refusedOutsideTurnLogged = false;
    try {
      // One author message can take more than one ACP turn: a command the
      // allowlist refused ends the turn under both adapters (see
      // `findRejectOption`), and the agent is never told why — so Slidra
      // takes the turn back, says what to use instead, and lets the agent
      // carry on. Bounded, because an agent that ignores the advice twice
      // will ignore it a third time.
      for (let correction = 0; ; correction++) {
        let response: acp.PromptResponse | undefined;
        let failure: unknown;
        try {
          response = await this.withInterrupt(
            this.connection!.prompt({
              sessionId: this.sessionId!,
              prompt: [{ type: "text", text: prompt }],
            }),
          );
        } catch (error) {
          failure = error;
        }

        // The turn ended without the agent getting anywhere: either the
        // adapter aborted it on our refusal (`cancelled`), or it turned
        // the refusal into a protocol error (claude-code-acp's
        // `interrupt: true`, which surfaces as `Internal error`). The
        // author pressing Stop is neither, and never continues.
        const hints = [...new Set(this.refusalHints.values())];
        const endedOnRefusal =
          this.refusedToolCalls.size > 0 &&
          !this.cancelledUntilNextPrompt &&
          (failure !== undefined || response?.stopReason === "cancelled");

        if (endedOnRefusal && hints.length > 0 && correction < MAX_REFUSAL_CORRECTIONS && !this.disposed) {
          // No notice here: the author was already told at the moment of
          // the refusal. Taking the turn back is plumbing.
          prompt = refusalCorrectionPrompt(hints);
          this.relayedToolCalls.clear();
          this.refusedToolCalls.clear();
          this.refusalHints.clear();
          continue;
        }

        if (failure !== undefined) {
          this.emitTyped("chat-error", { message: describeError(failure) });
          return;
        }
        // A refusal ended the turn and there was nothing useful to say
        // about it (or the advice has already been given twice): at least
        // tell the author it was not their Stop that did this.
        if (endedOnRefusal) {
          this.emitTyped("chat-notice", { text: TURN_ABORTED_BY_REFUSAL_MESSAGE });
        }
        this.emitTyped("chat-done", { stopReason: response!.stopReason });
        return;
      }
    } finally {
      this.relayingCurrentTurn = false;
      this.relayedToolCalls.clear();
      this.refusedToolCalls.clear();
      this.refusalHints.clear();
      await this.closeEditLockIfOpen();
    }
  }

  /**
   * Closes the history group and releases the editing lock this turn
   * opened, if it opened one — the "shared boundary" half of the contract
   * (opening happens in `requestPermission`, below). A turn that never ran
   * a command never opened either, and this is a no-op for it.
   *
   * `endHistoryGroup` failing (e.g. a disk error) must not leave the lock
   * held forever — that would freeze the whole server — so the release
   * always runs, in its own `finally`, while the failure itself is still
   * surfaced rather than swallowed.
   */
  private async closeEditLockIfOpen(): Promise<void> {
    if (!this.turnHasEditLock) return;
    this.turnHasEditLock = false;
    try {
      await endHistoryGroup(this.presentationId);
    } catch (error) {
      this.emitTyped("chat-error", { message: describeError(error) });
    } finally {
      this.editingLock.releaseAgent();
    }
  }

  /**
   * Races `operation` against whatever `activeReject` gets called with —
   * the child's `error`/`exit` handlers call it directly when stdio dies,
   * which is otherwise invisible to a pending ACP call (fix 1). Only one
   * ACP call is ever in flight at a time (turns are serialized by
   * `turnQueue`, and setup always completes before a prompt is sent), so a
   * single slot is enough.
   */
  private withInterrupt<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.activeReject = reject;
      operation.then(
        (value) => {
          this.activeReject = undefined;
          resolve(value);
        },
        (error) => {
          this.activeReject = undefined;
          reject(error);
        },
      );
    });
  }

  /**
   * Spawns the adapter, initializes it, opens a session and sends the
   * editorial brief as the very first `session/prompt` — idempotent and shared by
   * every caller so the sequence runs exactly once per `serve` process.
   */
  private ensureSession(): Promise<void> {
    if (!this.readyPromise) {
      this.settingUp = true;
      this.readyPromise = this.establishSession().catch(async (error) => {
        // A failed setup must be retried on the next message — but retrying
        // must spawn a genuinely fresh session, not leave the failed
        // child/connection/temp dir dangling while `this.child` etc. get
        // silently overwritten by the next attempt (fix 4: that made the
        // original child unreachable, even to dispose()). teardownSession()
        // is idempotent, so this is safe even when the dying child's own
        // handler already tore things down and rejected us here (fix 1).
        await this.teardownSession();
        throw error;
      });
      this.readyPromise = this.readyPromise.finally(() => {
        this.settingUp = false;
      });
    }
    return this.readyPromise;
  }

  /**
   * Tears down everything a live or failed session may have running: kills
   * the child and drops the connection/session id. Field-clearing happens
   * synchronously, before any `await`, so a session that dies mid-request
   * is never *remembered* as live — the very next `ensureSession()` call
   * always sees a clean slate and spawns a genuinely fresh attempt, with
   * nothing left for later code to remember to check (fix 1). Safe to call
   * more than once for the same attempt.
   *
   * Does **not** touch `workdirReal` — the product work directory belongs
   * to `SLIDRA_HOME`, deployed once by `deployAgentWorkdir()` before this
   * session is ever constructed, and outlives every session teardown,
   * including the process's own shutdown.
   */
  private async teardownSession(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.connection = undefined;
    this.sessionId = undefined;
    this.readyPromise = undefined;
    if (child && !child.killed) {
      child.kill();
    }
  }

  /**
   * The child (belonging to `generation`) exited or failed to spawn.
   * Whatever ACP call is currently awaited (setup or a turn) would
   * otherwise hang forever — the ACP SDK never settles a pending call on
   * its own once stdio is dead — so this rejects it directly via
   * `activeReject`, then tears the session down completely so the next
   * message starts fresh instead of reusing a dead child (fix 1).
   *
   * Ignored when `generation` is no longer `this.generation`: a stale
   * child's `exit` can fire well after a newer attempt has already taken
   * over (see the `generation` field's comment) and must not touch that
   * newer, healthy attempt's state.
   */
  private handleChildDown(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    const reject = this.activeReject;
    this.activeReject = undefined;
    reject?.(new SlidraError(`${this.config.label} 的連線已中斷（${reason}），請重新發送訊息`));
    void this.teardownSession();
  }

  private async establishSession(): Promise<void> {
    const generation = ++this.generation;
    // The `.slidra` this presentation was opened from, for the permission
    // policy's protected set. A registry that cannot be read is not worth
    // failing the session over: `<SLIDRA_HOME>` still covers the live
    // files, and the container is only reachable through a path the agent
    // was never told.
    this.sourcePath = (await readProjectsRegistry().catch(() => undefined))?.get(this.presentationId)?.sourcePath;
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.config.env ? { ...process.env, ...this.config.env } : process.env,
    });
    this.child = child;
    // The adapter's own diagnostics used to go to `"ignore"`, which is why
    // an adapter-side failure reached serve's log as nothing at all —
    // every question about *why* a turn behaved oddly had to be answered
    // by re-running it against a hand-written ACP client. Tagged with the
    // adapter's name so it is never mistaken for Slidra's own output.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") console.warn(`[${this.config.label}] ${line}`);
      }
    });
    // `error` fires when the process never spawns at all (e.g. the command
    // does not exist); `exit` fires whenever it stops running afterwards,
    // mid-setup or mid-turn. Both leave stdio dead, so both must reach for
    // `activeReject` directly — nothing else notices on its own (fix 1).
    child.once("error", (error) => {
      this.handleChildDown(generation, `啟動失敗：${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.handleChildDown(generation, signal ? `收到訊號 ${signal}` : `結束代碼 ${code}`);
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection((_agent) => this.buildClient(), stream);
    this.connection = connection;

    await this.withInterrupt(this.performHandshake(connection));
  }

  /** The actual initialize/newSession/editorial-brief-prompt sequence, wrapped by `establishSession` with `withInterrupt`. */
  private async performHandshake(connection: acp.ClientSideConnection): Promise<void> {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      // Both file methods are declared available (ADR-0004). readTextFile
      // is the obvious one — it serves the virtual file tree. writeTextFile
      // looks wrong at first glance: it is *always* refused, never once
      // succeeds. But ADR-0004's first layer depends on the method being
      // reachable: the refusal is how the agent learns which command to use
      // instead (user story 32). A capability declared `false` here is
      // never attempted by a well-behaved agent, so the one mechanism that
      // redirects it would never fire. `terminal` stays false — command
      // execution is the agent's own business (ADR-0006), never routed
      // through this client.
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    });

    let session: acp.NewSessionResponse;
    try {
      // The deployed product work directory (`deployAgentWorkdir()`,
      // already resolved to its real form) — the agent reads CLAUDE.md/
      // AGENTS.md/skills from here via its own native file access, and
      // `fs/read_text_file` also serves it (see `readTextFile` below).
      // Never re-deployed per session: the same directory is handed to
      // every attempt, including a reconnect after an adapter crash.
      session = await connection.newSession({ cwd: this.workdirReal, mcpServers: [] });
    } catch (error) {
      // Errors that cross the JSON-RPC wire arrive as a plain
      // `{ code, message, data }` object (see the SDK's own
      // `Connection#handleResponse`, which rejects with `response.error`
      // verbatim) — never as an `acp.RequestError` instance. Checking
      // `.code` structurally, not `instanceof`, is what actually catches
      // `RequestError.authRequired()` from the other side of the pipe.
      if (jsonRpcErrorCode(error) === AUTH_REQUIRED_CODE) {
        throw new SlidraError(
          `${this.config.label} 尚未登入。請在終端機完成 ${this.config.label} 的登入流程後，再重新發送訊息。`,
        );
      }
      throw error;
    }
    this.sessionId = session.sessionId;
    // ACP's model state is still marked experimental (`claude-code-acp`
    // sends it; `codex-acp` reports the same thing as a config option), so
    // this is read defensively and stays `null` when absent. The author sees
    // "which model am I talking to" under the chat box; saying nothing is
    // the honest answer when the adapter did not say.
    this.readModelState(session);
    if (this.preferredModelId !== null && this.preferredModelId !== this.modelId && this.modelMechanism) {
      const preferred = this.modelChoices.find((candidate) => candidate.id === this.preferredModelId);
      // A model the adapter no longer offers is simply not applied — the
      // adapter's own default is the truthful state, and the picker shows it.
      if (preferred) await this.applyModel(connection, session.sessionId, this.modelMechanism, preferred);
    }

    // The editorial brief is the first user message the agent ever sees — its own
    // `session/prompt` call, never folded into the author's first message.
    // `relayingCurrentTurn` stays false so any reply to it never reaches
    // the browser as if it were a response to something the author typed.
    const brief = buildEditorialBrief(this.presentationId);
    const executionGuidance = this.config.kind === "codex"
      ? "\n\nCodex 執行命令：工作階段是唯讀沙箱。執行 slidra 命令時請使用工具的 sandbox_permissions=require_escalated，讓 Slidra 逐次檢查並授權命令；不要先在唯讀沙箱嘗試修改。這也讓 Slidra 能在執行前取得編輯鎖並將復原快照歸入同一輪對話。不得要求永久授權。讀工作目錄裡的文件（AGENTS.md、reference/*.md、.agents/skills/*/SKILL.md）就是你的原生檔案讀取：在沙箱內用 cat 或 sed 讀相對路徑即可，這種唯讀命令不需要授權；slidra cat 只讀簡報本身的虛擬路徑（slides/001.svg、project.json、plan/outline.md），讀不到工作目錄的文件。"
      : "";
    await connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: brief + executionGuidance }],
    });
  }

  private buildClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        const update = params.update;
        // Unlike every other update kind below, this one is session-level
        // bookkeeping, not part of any particular turn — it almost always
        // arrives between `session/new` and the very first turn (see
        // `getReportedCommands`'s own comment), while `relayingCurrentTurn`
        // is still false. Handling it above that guard is what makes it
        // ever reach here at all.
        if (update.sessionUpdate === "available_commands_update") {
          this.reportedCommands = update.availableCommands;
          this.emitTyped("available-commands", { commands: update.availableCommands });
          return;
        }
        if (this.outsideTurn()) {
          this.droppedOutsideTurn += 1;
          return;
        }
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          this.emitTyped("chat-chunk", { text: update.content.text });
          return;
        }
        if (update.sessionUpdate === "tool_call") {
          this.relayCommandStart(update);
          return;
        }
        if (update.sessionUpdate === "tool_call_update") {
          this.relayCommandUpdate(update);
          return;
        }
        // Remaining update kinds (thoughts, plans) are the agent's own
        // bookkeeping, not something the author asked to see — this
        // sidebar is a view of the work, not a debug log. `available
        // commands` used to be lumped in here too; it now has its own
        // branch above, handled unconditionally rather than only during a
        // turn.
      },
      requestPermission: async (params: acp.RequestPermissionRequest) => {
        // #303: fail closed outside a turn — a stopped adapter that keeps
        // asking gets `cancelled` every time, and we say so once.
        if (this.outsideTurn()) {
          if (!this.refusedOutsideTurnLogged) {
            this.refusedOutsideTurnLogged = true;
            console.warn("[agent] 沒有進行中的回合，拒絕 agent 的命令請求（已停止的回合仍在送出請求）");
          }
          return { outcome: { outcome: "cancelled" } };
        }
        // Only a command actually about to run needs the floor — a request
        // the allowlist was always going to refuse touches nothing on
        // disk, so freezing for it would be pure side effect with no
        // corresponding write to protect (and would open/immediately-close
        // an empty history group for every refused command, for nothing).
        if (isSlidraCliCommand(params)) {
          await this.openEditLockOnFirstCommand();
        }
        return this.decidePermission(params);
      },
      readTextFile: async (params: acp.ReadTextFileRequest) => {
        return this.readTextFile(params);
      },
      writeTextFile: async () => {
        // Always refused (ADR-0004, first layer) — see WRITE_REFUSED_MESSAGE
        // for why the capability is nonetheless advertised as available.
        throw new acp.RequestError(WRITE_REFUSED_CODE, WRITE_REFUSED_MESSAGE);
      },
      // `@agentclientprotocol/codex-acp` sends `_auth/status_update` (which
      // account the session is on) as an extension notification. Nothing
      // here needs it, and without a handler the SDK logs a "Method not
      // found" error for every one.
      extNotification: async () => {},
    };
  }

  /**
   * A `tool_call` update announcing that the agent is about to run
   * something. Only tool calls that actually name a shell command are
   * relayed — the command text comes straight out of ACP's
   * `rawInput.command`, exactly as `decidePermission` reads it, and is
   * never reassembled from anything else. Tool calls with no command (a
   * file read, an agent-internal tool) are the agent's own business and
   * stay off the author's screen.
   *
   * The command string is shown to the author verbatim, real paths and
   * all. ADR-0004's third layer governs what the *agent* is allowed to
   * see; this event travels the other way, to the person who owns the
   * machine ("it's the agent being blocked, not the human").
   */
  private relayCommandStart(update: { toolCallId: string; rawInput?: unknown; status?: acp.ToolCallStatus }): void {
    const command = extractCommand(update);
    if (command === undefined) return;
    // Every command the agent runs is shown — since ADR-0019 that includes
    // its own shell work (reading its references, grepping, temp files),
    // and the author is entitled to see what is happening on their
    // machine. What only the CLI gets is a *status*: running/complete/failed is
    // a claim about the presentation, and a failed `grep` of the agent's
    // own notes is the agent's problem to solve, not an outcome the author
    // is being asked to read. So a non-CLI command is relayed once, as the
    // line it is, and never updated.
    const cli = namesSlidraProgram(command);
    if (cli) this.relayedToolCalls.add(update.toolCallId);
    this.emitTyped("chat-command", {
      toolCallId: update.toolCallId,
      // ACP declares `status` optional on `tool_call` and specifies
      // `pending` as its meaning when absent — this is the protocol's own
      // default, not a guess standing in for missing information.
      command,
      status: update.status ?? "pending",
      cli,
    });
  }

  /**
   * A `tool_call_update` for a command already on the author's screen.
   * Ignored for any tool call `relayCommandStart` did not relay — an
   * update whose `toolCallId` was never shown has nothing to update.
   *
   * The command's own output is attached only when the command failed:
   * that is the case the author cannot otherwise diagnose without opening
   * a terminal (a `command not found` exit 127 is exactly the failure this
   * ticket exists for). Successful output is left to the agent to
   * summarize in its own words.
   */
  private relayCommandUpdate(update: {
    toolCallId: string;
    status?: acp.ToolCallStatus | null;
    content?: acp.ToolCallContent[] | null;
    rawOutput?: unknown;
  }): void {
    if (!this.relayedToolCalls.has(update.toolCallId)) return;
    // An update carrying no status is a content/location-only update —
    // nothing the author's view of "running / done / failed" reacts to.
    if (update.status == null) return;
    // A command the allowlist refused never ran, so the adapter's own
    // "the user rejected this" text describes neither what happened nor
    // who did it — Slidra's wording replaces it.
    const blocked = update.status === "failed" && this.refusedToolCalls.has(update.toolCallId);
    const hint = this.refusalHints.get(update.toolCallId);
    const output = blocked
      ? hint === undefined
        ? BLOCKED_COMMAND_MESSAGE
        : `${BLOCKED_COMMAND_MESSAGE}\n${hint}`
      : update.status === "failed"
        ? extractCommandOutput(update.content, update.rawOutput)
        : undefined;
    this.emitTyped("chat-command-update", {
      toolCallId: update.toolCallId,
      status: update.status,
      ...(output === undefined ? {} : { output }),
      ...(blocked ? { blocked: true as const } : {}),
    });
  }

  /**
   * The freeze/undo-group boundary's entry point: the author's turn's
   * first `session/request_permission` call — never the editorial brief
   * turn (`relayingCurrentTurn` is false for it) — waits for
   * `editingLock.acquireAgent()` (which itself waits out any in-progress
   * human edit rather than throwing) and opens the history group. Every
   * later command in the same turn sees `turnHasEditLock` already true and
   * returns immediately — no second acquire, no second group. Only called
   * for a request the allowlist is actually going to allow (see the
   * `requestPermission` call site) — a refused command touches nothing on
   * disk, so there is nothing for the lock/group to protect.
   */
  private async openEditLockOnFirstCommand(): Promise<void> {
    if (!this.relayingCurrentTurn || this.turnHasEditLock) return;
    await this.editingLock.acquireAgent();
    this.turnHasEditLock = true;
    await beginHistoryGroup(this.presentationId);
  }

  /**
   * `session/request_permission` — the second layer of ADR-0004. Allows a
   * request only when the command it names is structurally guaranteed to
   * invoke the `slidra` program and nothing else (see
   * `command-allowlist.ts`); refuses everything else, including any request
   * the command cannot be extracted from at all. The rule is hard-coded —
   * the author is never asked (user story 12).
   *
   * When allowing, only `allow_once` is ever selected — never
   * `allow_always`. Some adapters stop calling `session/request_permission`
   * for a tool entirely once a persistent grant has been given, which would
   * silently disable this whole gate for every later command in the
   * session, including ones that are not `slidra` at all. If the
   * adapter does not offer `allow_once`, the request is refused rather than
   * falling back to a permanent grant — a visible, recoverable refusal
   * beats a permission layer that quietly stops running. (The real
   * `claude-code-acp` 0.12.6 offers `allow_once`, so this does not affect
   * that path.) Rejecting has no equivalent risk, so `reject_once` and
   * `reject_always` are both acceptable there.
   */
  /**
   * The permission policy (ADR-0004's second layer, as re-drawn): the CLI
   * is the only way to change a `.slidra`, and everything else the agent
   * wants to run is its own business. So a `slidra` command is allowed
   * because it *is* the CLI, and every other command is allowed unless it
   * names one of the presentation's real files (`touchesProtectedPath`).
   *
   * A tool call carrying no command string at all is not a shell command
   * and has nothing to judge — but its raw input is still scanned for a
   * protected path, so an unrecognised shell shape (Codex has more than
   * one) cannot slip a work-directory path past this by arriving in a
   * field this code does not know how to read.
   */
  private isPermittedCommand(params: acp.RequestPermissionRequest): boolean {
    const command = extractCommand(params.toolCall);
    if (command !== undefined) {
      if (isSlidraCommand(command)) return true;
      // A command an encoder shell-quoted (see `unquoteShellWord`) is
      // judged on the literal text it stands for, never on the quoting.
      const literal = unquoteShellWord(command);
      if (literal !== undefined && isSlidraCommand(literal)) return true;
      return !touchesProtectedPath(literal ?? command, this.protectedPaths);
    }
    return !touchesProtectedPath(collectStrings(params.toolCall.rawInput).join(" "), this.protectedPaths);
  }

  /** Where the presentation's real files live — see `protected-paths.ts`. */
  private get protectedPaths(): ProtectedPaths {
    return {
      slidraHome: resolveSlidraHome(),
      agentWorkdir: this.workdirReal,
      ...(this.sourcePath === undefined ? {} : { sourcePath: this.sourcePath }),
    };
  }

  private decidePermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const allow = this.isPermittedCommand(params);
    if (!allow) {
      const first = this.refusedToolCalls.size === 0;
      this.refusedToolCalls.add(params.toolCall.toolCallId);
      // What to use instead, decided here (where the refused command
      // string is still in hand) and delivered in two directions: to the
      // author with the blocked command, and to the agent itself once the
      // turn ends (`deliverRefusalHints`).
      const command = extractCommand(params.toolCall);
      const hint = command === undefined ? undefined : hintForBlockedCommand(command, this.presentationId);
      if (hint !== undefined) this.refusalHints.set(params.toolCall.toolCallId, hint);
      // The refused command itself never reaches the timeline (it is not a
      // `slidra` command, and `relayCommandStart` shows only those), so
      // this one line is the whole of what the author sees: Slidra acted,
      // here is what it said. Once per turn — an agent that tries three
      // spellings of the same forbidden thing is not three events.
      if (first) this.emitTyped("chat-notice", { text: refusalNotice(hint) });
    }
    const option = allow
      ? params.options.find((candidate) => candidate.kind === "allow_once")
      : this.findRejectOption(params.options);
    if (!option) {
      // Cannot express the decision through any offered option — including
      // the case where we mean to allow but the agent offered no
      // `allow_once` option (and, deliberately, no fallback to
      // `allow_always` — see docstring above). Fail closed: `cancelled`
      // grants nothing.
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  /**
   * Picks the refusal that costs the turn the least. ACP says only "reject
   * once" / "reject always", but `codex-acp` offers two different
   * `reject_once` options behind those: `decline` ("No, continue without
   * running it") lets the agent keep going and correct itself, while
   * `cancel` ("No, and tell Codex what to do differently") is Codex's
   * *abort* — it kills the whole turn, which is how a blocked command used
   * to leave the author staring at a stopped conversation. So `decline` is
   * taken by name when it is on offer; everything else falls back to the
   * kinds ACP actually defines, and `cancel` remains the last resort
   * (refusing is still better than allowing).
   */
  private findRejectOption(options: acp.PermissionOption[]): acp.PermissionOption | undefined {
    return (
      options.find((candidate) => candidate.kind === "reject_once" && candidate.optionId === "decline") ??
      options.find((candidate) => candidate.kind === "reject_once") ??
      options.find((candidate) => candidate.kind === "reject_always")
    );
  }

  /**
   * `fs/read_text_file` — third layer of ADR-0004. `params.path` is either
   * a virtual path the brief or `reference/commands.md` names directly
   * (e.g. "slides/001.svg", "CLAUDE.md") or, per a real `claude-code-acp`
   * 0.12.6 probe, an *absolute* path rooted at the session cwd (fix 3 — a
   * conforming agent sends this shape, so refusing to understand it means
   * a real agent cannot read anything at all). `classifyAgentReadPath`
   * translates the latter back into the former and decides which of the
   * two real trees — the presentation's virtual tree, or the deployed work
   * directory — the (now-relative) path belongs to; either way the read
   * goes through the same kind of structural lookup, never a raw
   * `readFile` on caller-supplied input.
   */
  private async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const target = classifyAgentReadPath(params.path, this.workdirReal);
    if (target.kind === "refused") {
      // An absolute path outside the work directory: refused explicitly and
      // never resolved against the real filesystem (fix 3). The message
      // deliberately does not echo the (real filesystem) path back.
      throw new acp.RequestError(READ_NOT_FOUND_CODE, PATH_OUTSIDE_SESSION_CWD_MESSAGE);
    }
    let content: string;
    try {
      content =
        target.kind === "presentation"
          ? await readPresentationText(this.presentationId, target.virtualPath)
          : await readAgentWorkdirFile(this.workdirReal, target.relativePath);
    } catch (error) {
      // Preserve the existing Traditional-Chinese wording verbatim — these
      // messages already never contain a real path (ADR-0004, third layer).
      // The NotFound/other split mirrors the one the HTTP layer already
      // makes (readVirtualFile / raw.ts): only a positively-absent path
      // gets the "not found" JSON-RPC code, everything else is a generic
      // internal error.
      if (error instanceof SlidraNotFoundError) {
        throw new acp.RequestError(READ_NOT_FOUND_CODE, error.message);
      }
      if (error instanceof SlidraError) {
        throw new acp.RequestError(READ_FAILED_CODE, error.message);
      }
      throw error;
    }
    return { content: applyLineWindow(content, params.line, params.limit) };
  }

  /**
   * Attaches one SSE stream to this session's events; returns a detach
   * function. Deliberately does NOT forward `available-commands`: that
   * event is a session-level fact with no turn to belong to, and every
   * event this stream (`/api/chat/stream`) carries is turn bookkeeping
   * (`turnInFlight`/`setWorking` on the client side) — mixing a
   * conversation-unrelated notification into it would make "is the agent
   * working" readable from an event that has nothing to do with a turn.
   * `serve.ts` broadcasts it separately over `/api/events` instead (see
   * `commands.ts` and the `agent-commands` SSE event).
   */
  attachStream(send: (event: keyof ChatEvents, data: unknown) => void): () => void {
    const onChunk: ChatEvents["chat-chunk"] = (payload) => send("chat-chunk", payload);
    const onDone: ChatEvents["chat-done"] = (payload) => send("chat-done", payload);
    const onError: ChatEvents["chat-error"] = (payload) => send("chat-error", payload);
    const onCommand: ChatEvents["chat-command"] = (payload) => send("chat-command", payload);
    const onCommandUpdate: ChatEvents["chat-command-update"] = (payload) => send("chat-command-update", payload);
    const onNotice: ChatEvents["chat-notice"] = (payload) => send("chat-notice", payload);
    this.on("chat-notice", onNotice);
    this.on("chat-chunk", onChunk);
    this.on("chat-done", onDone);
    this.on("chat-error", onError);
    this.on("chat-command", onCommand);
    this.on("chat-command-update", onCommandUpdate);
    return () => {
      this.off("chat-notice", onNotice);
      this.off("chat-chunk", onChunk);
      this.off("chat-done", onDone);
      this.off("chat-error", onError);
      this.off("chat-command", onCommand);
      this.off("chat-command-update", onCommandUpdate);
    };
  }

  /** Kills the adapter subprocess. Called once from `serve`'s shutdown disposer. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.removeAllListeners();
    await this.closeEditLockIfOpen();
    await this.teardownSession();
  }
}

function toChoice(info: acp.ModelInfo): AgentModelChoice {
  // `claude-code-acp` names the unpinned default "Default (recommended)" and
  // puts which models that actually resolves to in the description — so the
  // description is kept, as the picker's tooltip.
  return { id: info.modelId, name: info.name, ...(info.description ? { detail: info.description } : {}) };
}

/**
 * True for an invocation of the `slidra` CLI itself. The T5 freeze gate
 * uses this (and not the permission decision) because it is the CLI, and
 * only the CLI, that writes to the presentation — a `curl` the policy now
 * allows must not open a history group.
 */
function isSlidraCliCommand(params: acp.RequestPermissionRequest): boolean {
  const command = extractCommand(params.toolCall);
  if (command === undefined) return false;
  if (isSlidraCommand(command)) return true;
  // The strict grammar is no longer what decides whether a command runs,
  // so the gate cannot depend on it either: `slidra undo X | head` is
  // still the CLI writing to the presentation and still has to freeze.
  if (namesSlidraProgram(command)) return true;
  // Second chance for a command that reached us shell-*quoted* rather than
  // as the script itself (see `unquoteShellWord`). The allowlist itself is
  // unchanged and still has the last word — this only decides which string
  // it is asked about.
  const literal = unquoteShellWord(command);
  return literal !== undefined && isSlidraCommand(literal);
}

/**
 * Undoes one known encoder: `@agentclientprotocol/codex-acp` hands
 * `session/request_permission` the shell-quoted *display* form of the
 * command rather than the script itself, so a command carrying any
 * quoting of its own arrives as e.g.
 * `"slidra plan set abc outline '"'…'` where the `tool_call` update
 * carried `slidra plan set abc outline '…'`. The allowlist refuses that
 * on the leading `"` — which is why every writing command was blocked
 * under this adapter while every read (which the sandbox runs without
 * asking) went through.
 *
 * Returns the concatenated *literal* text of a word built from adjacent
 * unquoted / single-quoted / double-quoted chunks, or undefined the moment
 * anything falls outside that shape — an unterminated quote, a backslash
 * outside double quotes, an escape other than `\"`/`\\`, or a `$`,
 * backtick or `!` inside double quotes (all three still expand there, so a
 * double-quoted chunk containing one is not literal text and this refuses
 * to read it as such), or a word that does not start quoted at all.
 *
 * This is not the shell parser `command-allowlist.ts` warns against, and
 * it must not grow into one: it decides nothing. Unquoting only ever
 * *removes* quoting, so every character the shell would act on survives
 * into the returned string and the allowlist judges it under rules 1–6
 * unchanged — a `;` that was quoted comes out as a `;` and is refused.
 * The original string is tried first, so no command that was allowed
 * before now takes this path.
 */
function unquoteShellWord(command: string): string | undefined {
  // Only a word an encoder quoted from its very first character — never a
  // command the agent itself wrote, whose first token is the program name
  // (rule 1) and which therefore keeps rule 3's outright refusal of double
  // quotes anywhere in it.
  if (!command.startsWith('"')) return undefined;
  const chars = Array.from(command);
  let literal = "";
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "'") {
      i++;
      let closed = false;
      while (i < chars.length) {
        if (chars[i] === "'") {
          closed = true;
          i++;
          break;
        }
        literal += chars[i++];
      }
      if (!closed) return undefined;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < chars.length) {
        const inner = chars[i];
        if (inner === '"') {
          closed = true;
          i++;
          break;
        }
        if (inner === "$" || inner === "`" || inner === "!") return undefined;
        if (inner === "\\") {
          const escaped = chars[i + 1];
          if (escaped !== '"' && escaped !== "\\") return undefined;
          literal += escaped;
          i += 2;
          continue;
        }
        literal += inner;
        i++;
      }
      if (!closed) return undefined;
      continue;
    }
    if (ch === "\\") return undefined;
    literal += ch;
    i++;
  }
  return literal;
}

/**
 * Every string sitting anywhere in a raw input, so an unrecognised tool
 * shape can still be checked for a protected path. Deliberately shallow in
 * ambition: it looks at the values, not at what the fields mean.
 */
function collectStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth > 4 || typeof value !== "object" || value === null) return [];
  return Object.values(value as Record<string, unknown>).flatMap((child) => collectStrings(child, depth + 1));
}

/** True when the command's first word invokes `slidra`, whatever follows it. */
function namesSlidraProgram(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  return first !== undefined && first.replace(/^['"]|['"]$/g, "").split("/").pop() === "slidra";
}

/** Recognizes Claude's command string and Codex's shell argv; unknown shapes fail closed. */
function extractCommand(toolCall: { rawInput?: unknown }): string | undefined {
  const rawInput = toolCall.rawInput;
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const command = (rawInput as Record<string, unknown>).command;
  if (typeof command === "string") return command;
  // Codex sends the actual exec argv, including its shell wrapper. Only
  // unwrap a known shell with exactly one script; the existing allowlist
  // still validates that entire script (never the display title/parsed_cmd).
  if (!Array.isArray(command) || command.length !== 3 || !command.every((arg) => typeof arg === "string")) {
    return undefined;
  }
  if (!["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"].includes(command[0])) return undefined;
  if (command[1] !== "-c" && command[1] !== "-lc") return undefined;
  return command[2];
}


/**
 * Pulls a failed command's own output out of a `tool_call_update`'s
 * content blocks (ticket #17). Only plain-text blocks are taken — an image
 * or an embedded resource is not what "the command printed this" means.
 * Returns undefined when there is nothing to show, so the event simply
 * carries no `output` field rather than an empty string pretending to be
 * output.
 */
function extractCommandOutput(content: acp.ToolCallContent[] | null | undefined, rawOutput?: unknown): string | undefined {
  const texts: string[] = [];
  for (const block of content ?? []) {
    if (block.type === "content" && block.content.type === "text") {
      texts.push(block.content.text);
    }
  }
  // `@agentclientprotocol/codex-acp` puts a command's output in
  // `rawOutput.formatted_output` (its `content` is a terminal reference,
  // not text); `claude-code-acp` puts it in text content blocks.
  if (texts.length === 0 && typeof rawOutput === "object" && rawOutput !== null) {
    const formatted = (rawOutput as Record<string, unknown>).formatted_output;
    if (typeof formatted === "string" && formatted !== "") texts.push(formatted);
  }
  if (texts.length === 0) return undefined;
  // Whole output, never a prefix. A truncated failure is the one kind of
  // output that is useless: the part that says what went wrong is as
  // likely to be at the end as at the start, and an author who cannot see
  // it has to go and re-run the command in a terminal — which is the
  // problem this relay exists to remove.
  return texts.join("\n");
}

/**
 * Applies ACP's `line`/`limit` windowing to a file's full text content.
 * Per the SDK's schema: `line` is the 1-based line number to start from,
 * `limit` is the maximum number of lines to return. Neither given returns
 * the content untouched — the common case, and the one the behaviour
 * contract requires to be byte-for-byte identical to `cat`.
 */
function applyLineWindow(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const startIndex = line != null ? Math.max(line - 1, 0) : 0;
  const endIndex = limit != null ? startIndex + limit : lines.length;
  return lines.slice(startIndex, endIndex).join("\n");
}

/** Pulls a JSON-RPC error code off either a real `Error` or the plain `{code, message}" object the SDK rejects requests with. */
function jsonRpcErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  if (error instanceof SlidraError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
