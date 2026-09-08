import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  CoMotionError,
  CoMotionNotFoundError,
  readPresentationFile,
  beginHistoryGroup,
  endHistoryGroup,
  listAllComments,
  type SlideCommentWithPath,
} from "@co-motion/core";
import type { AgentKind } from "./adapters.js";
import { buildEditorialBrief } from "./brief.js";
import { isCoMotionCommand } from "./command-allowlist.js";
import type { EditingLock } from "../editing-lock.js";

/**
 * `fs/write_text_file` is always refused (ADR-0004, first layer). The
 * message names the one command that exists for editing text today, so an
 * agent that tries to write directly can correct itself on the very next
 * turn (user story 32) instead of merely learning that it failed.
 */
const WRITE_REFUSED_MESSAGE =
  "CoMotion 不允許 agent 直接寫入檔案，這個方法一律會被拒絕。若要修改文字內容，請改執行 `co-motion text set` 命令。";

/**
 * [E2.T8]: builds the `/api/chat` prompt's comment-context prefix, or
 * `null` when there are no comments — a message with nothing pinned to it
 * must go out byte-identical to what the author typed (AC13, guarded by
 * `chat.test.ts`'s existing "編輯規約" assertion). A standalone pure
 * function, not a private method, so a unit test can verify the exact
 * format without spinning up an ACP session.
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
const MAX_COMMAND_OUTPUT_CHARS = 2000;
const COMMAND_OUTPUT_TRUNCATED_SUFFIX = "\n…（輸出過長，僅顯示前段）";

/** Events an `AgentChatSession` emits while a user-triggered turn is active. */
interface ChatEvents {
  "chat-chunk": (payload: { text: string }) => void;
  "chat-done": (payload: { stopReason: string }) => void;
  "chat-error": (payload: { message: string }) => void;
  /** A command the agent has started running — `command` verbatim from ACP's `rawInput.command`. */
  "chat-command": (payload: { toolCallId: string; command: string; status: acp.ToolCallStatus }) => void;
  /** A status change on a command already relayed by `chat-command`. `output` only ever accompanies a failure. */
  "chat-command-update": (payload: {
    toolCallId: string;
    status: acp.ToolCallStatus;
    output?: string;
  }) => void;
}

/**
 * The shape `AgentChatSession.attachStream` accepts — pulled out as its own
 * exported type so `AgentManager` (NOOP-230's session-switching facade,
 * `manager.ts`) can declare the same signature for its own `attachStream`
 * without reaching into `ChatEvents`, which stays unexported.
 */
export type ChatStreamSend = (event: keyof ChatEvents, data: unknown) => void;

/**
 * Drives one ACP adapter subprocess for the lifetime of `co-motion serve`.
 *
 * Spawning is lazy (first `sendMessage`), the session is persistent across
 * messages (§4 of the ticket), and the 編輯規約 is sent as its own, separate
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
   * The empty `mkdtemp` directory handed to the agent as its session `cwd`
   * (fix 1). Tracked here so `dispose()` (and a failed-start teardown) can
   * remove it — nothing in this directory belongs to the user, so its
   * lifetime is scoped to the session, not the OS temp cleanup schedule.
   */
  private sessionCwd: string | undefined;
  /**
   * `sessionCwd`, resolved to its real (symlink-free) form (fix 3). A
   * conforming ACP agent echoes back an *absolute* path rooted at the cwd
   * it was given — but resolved, not verbatim (confirmed against a real
   * `claude-code-acp` 0.12.6: the cwd sent to `session/new` was
   * `/var/folders/...`, the `path` a subsequent `fs/read_text_file` sent
   * back was `/private/var/folders/...` — macOS resolves that `/var`
   * symlink). Comparing an absolute `path` against the raw `mkdtemp` string
   * would therefore fail on every single real read; comparing against this
   * resolved form is what actually matches.
   */
  private sessionCwdReal: string | undefined;
  private readyPromise: Promise<void> | undefined;
  /** Serializes turns so two `sendMessage` calls never interleave on one session. */
  private turnQueue: Promise<void> = Promise.resolve();
  /** True only while relaying updates for a turn the author actually asked for — not for the 編輯規約 turn. */
  private relayingCurrentTurn = false;
  /**
   * `toolCallId`s already relayed to the author as commands (ticket #17).
   * A `tool_call_update` carries only the id — never `rawInput` again — so
   * without this there is no way to tell an update about a command the
   * author is watching from an update about a tool call that was never
   * shown (a file read, a plan). Cleared at the end of every turn: ids are
   * scoped to the turn that showed them.
   */
  private readonly relayedToolCalls = new Set<string>();
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

  constructor(config: AgentAdapterConfig, presentationId: string, editingLock: EditingLock) {
    super();
    this.config = config;
    this.presentationId = presentationId;
    this.editingLock = editingLock;
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

  /**
   * Sends the author's message. Returns once the message has been queued —
   * callers must not await the whole agent turn (the HTTP handler responds
   * immediately; the reply streams separately over SSE).
   */
  sendMessage(text: string): void {
    this.turnQueue = this.turnQueue.then(() => this.runTurn(text));
    // A rejected turn must not poison the queue for the next message.
    this.turnQueue = this.turnQueue.catch(() => {});
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
        prompt = `${context}\n\n【作者的訊息】\n${text}`;
      }
    } catch (error) {
      this.emitTyped("chat-error", { message: describeError(error) });
      return;
    }

    this.relayingCurrentTurn = true;
    try {
      const response = await this.withInterrupt(
        this.connection!.prompt({
          sessionId: this.sessionId!,
          prompt: [{ type: "text", text: prompt }],
        }),
      );
      this.emitTyped("chat-done", { stopReason: response.stopReason });
    } catch (error) {
      this.emitTyped("chat-error", { message: describeError(error) });
    } finally {
      this.relayingCurrentTurn = false;
      this.relayedToolCalls.clear();
      await this.closeEditLockIfOpen();
    }
  }

  /**
   * Closes the history group and releases the editing lock this turn
   * opened, if it opened one — the "共用同一條界線" half of the contract
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
   * 編輯規約 as the very first `session/prompt` — idempotent and shared by
   * every caller so the sequence runs exactly once per `serve` process.
   */
  private ensureSession(): Promise<void> {
    if (!this.readyPromise) {
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
    }
    return this.readyPromise;
  }

  /**
   * Tears down everything a live or failed session may have running: kills
   * the child, drops the connection/session id, and removes the temp cwd.
   * Field-clearing happens synchronously, before any `await`, so a session
   * that dies mid-request is never *remembered* as live — the very next
   * `ensureSession()` call always sees a clean slate and spawns a
   * genuinely fresh attempt, with nothing left for later code to remember
   * to check (fix 1). Safe to call more than once for the same attempt.
   */
  private async teardownSession(): Promise<void> {
    const child = this.child;
    const sessionCwd = this.sessionCwd;
    this.child = undefined;
    this.connection = undefined;
    this.sessionId = undefined;
    this.sessionCwd = undefined;
    this.sessionCwdReal = undefined;
    this.readyPromise = undefined;
    if (child && !child.killed) {
      child.kill();
    }
    if (sessionCwd) {
      await rm(sessionCwd, { recursive: true, force: true }).catch(() => {});
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
    reject?.(new CoMotionError(`${this.config.label} 的連線已中斷（${reason}），請重新發送訊息`));
    void this.teardownSession();
  }

  private async establishSession(): Promise<void> {
    const generation = ++this.generation;
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
      env: this.config.env ? { ...process.env, ...this.config.env } : process.env,
    });
    this.child = child;
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

  /** The actual initialize/newSession/編輯規約-prompt sequence, wrapped by `establishSession` with `withInterrupt`. */
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

    // A dedicated, empty directory — never the user's project directory
    // (ADR-0004: a real path is a map the agent will use) and never under
    // CO_MOTION_HOME (that would disclose the home, and `..` from there
    // reaches `work/<id>`, the presentation's real work directory). The
    // system temp directory is unrelated to both, so this is the right
    // neighbourhood for a cwd the protocol requires but which must hold
    // nothing of the user's.
    const sessionCwd = await mkdtemp(path.join(tmpdir(), "co-motion-agent-cwd-"));
    this.sessionCwd = sessionCwd;
    // Resolved once, up front, against the directory `mkdtemp` actually
    // created — not against whatever the agent later sends back — so
    // `readTextFile`'s prefix comparison (fix 3) is anchored to a real
    // filesystem fact instead of trusting the agent's own path shape.
    this.sessionCwdReal = await realpath(sessionCwd);

    let session: acp.NewSessionResponse;
    try {
      session = await connection.newSession({ cwd: sessionCwd, mcpServers: [] });
    } catch (error) {
      // Errors that cross the JSON-RPC wire arrive as a plain
      // `{ code, message, data }` object (see the SDK's own
      // `Connection#handleResponse`, which rejects with `response.error`
      // verbatim) — never as an `acp.RequestError` instance. Checking
      // `.code` structurally, not `instanceof`, is what actually catches
      // `RequestError.authRequired()` from the other side of the pipe.
      if (jsonRpcErrorCode(error) === AUTH_REQUIRED_CODE) {
        throw new CoMotionError(
          `${this.config.label} 尚未登入。請在終端機完成 ${this.config.label} 的登入流程後，再重新發送訊息。`,
        );
      }
      throw error;
    }
    this.sessionId = session.sessionId;

    // The 編輯規約 is the first user message the agent ever sees — its own
    // `session/prompt` call, never folded into the author's first message.
    // `relayingCurrentTurn` stays false so any reply to it never reaches
    // the browser as if it were a response to something the author typed.
    const brief = buildEditorialBrief(this.presentationId);
    const executionGuidance = this.config.kind === "codex"
      ? "\n\nCodex 執行命令：工作階段是唯讀沙箱。執行 co-motion 命令時請使用工具的 sandbox_permissions=require_escalated，讓 CoMotion 逐次檢查並授權命令；不要先在唯讀沙箱嘗試修改。這也讓 CoMotion 能在執行前取得編輯鎖並將復原快照歸入同一輪對話。不得要求永久授權或執行其他 shell 命令。"
      : "";
    await connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: brief + executionGuidance }],
    });
  }

  private buildClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        if (!this.relayingCurrentTurn) return;
        const update = params.update;
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
        // Remaining update kinds (thoughts, plans, available commands) are
        // the agent's own bookkeeping, not something the author asked to
        // see — this sidebar is a view of the work, not a debug log.
      },
      requestPermission: async (params: acp.RequestPermissionRequest) => {
        // Only a command actually about to run needs the floor — a request
        // the allowlist was always going to refuse touches nothing on
        // disk, so freezing for it would be pure side effect with no
        // corresponding write to protect (and would open/immediately-close
        // an empty history group for every refused command, for nothing).
        if (isAllowedCommand(params)) {
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
    };
  }

  /**
   * A `tool_call` update announcing that the agent is about to run
   * something (ticket #17). Only tool calls that actually name a shell
   * command are relayed — the command text comes straight out of ACP's
   * `rawInput.command`, exactly as `decidePermission` reads it, and is
   * never reassembled from anything else. Tool calls with no command (a
   * file read, an agent-internal tool) are the agent's own business and
   * stay off the author's screen.
   *
   * The command string is shown to the author verbatim, real paths and
   * all. ADR-0004's third layer governs what the *agent* is allowed to
   * see; this event travels the other way, to the person who owns the
   * machine ("擋的是 agent，不是人").
   */
  private relayCommandStart(update: { toolCallId: string; rawInput?: unknown; status?: acp.ToolCallStatus }): void {
    const command = extractCommand(update);
    if (command === undefined) return;
    this.relayedToolCalls.add(update.toolCallId);
    this.emitTyped("chat-command", {
      toolCallId: update.toolCallId,
      // ACP declares `status` optional on `tool_call` and specifies
      // `pending` as its meaning when absent — this is the protocol's own
      // default, not a guess standing in for missing information.
      command,
      status: update.status ?? "pending",
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
  }): void {
    if (!this.relayedToolCalls.has(update.toolCallId)) return;
    // An update carrying no status is a content/location-only update —
    // nothing the author's view of "running / done / failed" reacts to.
    if (update.status == null) return;
    const output = update.status === "failed" ? extractCommandOutput(update.content) : undefined;
    this.emitTyped("chat-command-update", {
      toolCallId: update.toolCallId,
      status: update.status,
      ...(output === undefined ? {} : { output }),
    });
  }

  /**
   * The freeze/undo-group boundary's entry point (T5, NOOP-93/#110): the
   * author's turn's first `session/request_permission` call — never the
   * 編輯規約 turn (`relayingCurrentTurn` is false for it) — waits for
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
   * invoke the `co-motion` program and nothing else (see
   * `command-allowlist.ts`); refuses everything else, including any request
   * the command cannot be extracted from at all. The rule is hard-coded —
   * the author is never asked (user story 12).
   *
   * When allowing, only `allow_once` is ever selected — never
   * `allow_always`. Some adapters stop calling `session/request_permission`
   * for a tool entirely once a persistent grant has been given, which would
   * silently disable this whole gate for every later command in the
   * session, including ones that are not `co-motion` at all. If the
   * adapter does not offer `allow_once`, the request is refused rather than
   * falling back to a permanent grant — a visible, recoverable refusal
   * beats a permission layer that quietly stops running. (The real
   * `claude-code-acp` 0.12.6 offers `allow_once`, so this does not affect
   * that path.) Rejecting has no equivalent risk, so `reject_once` and
   * `reject_always` are both acceptable there.
   */
  private decidePermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const allow = isAllowedCommand(params);
    const option = allow
      ? params.options.find((candidate) => candidate.kind === "allow_once")
      : params.options.find((candidate) => candidate.kind === "reject_once") ??
        params.options.find((candidate) => candidate.kind === "reject_always");
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
   * `fs/read_text_file` — third layer of ADR-0004. `params.path` is either
   * the virtual path the brief names directly (e.g. "slides/001.svg") or,
   * per a real `claude-code-acp` 0.12.6 probe, an *absolute* path rooted at
   * the session cwd (fix 3 — a conforming agent sends this shape, so
   * refusing to understand it means a real agent cannot read anything at
   * all). `toVirtualPath` translates the latter back into the former;
   * either way the result goes through the exact same structural lookup
   * every other read uses (`readPresentationFile`) — the virtual tree
   * remains the only containment, the cwd prefix is only ever a
   * translation rule.
   */
  private async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const virtualPath = this.toVirtualPath(params.path);
    if (virtualPath === undefined) {
      // An absolute path outside the session cwd: refused explicitly and
      // never resolved against the real filesystem (fix 3). The message
      // deliberately does not echo the (real filesystem) path back.
      throw new acp.RequestError(READ_NOT_FOUND_CODE, PATH_OUTSIDE_SESSION_CWD_MESSAGE);
    }
    let content: string;
    try {
      content = await readPresentationFile(this.presentationId, virtualPath);
    } catch (error) {
      // Preserve the existing Traditional-Chinese wording verbatim — these
      // messages already never contain a real path (ADR-0004, third layer).
      // The NotFound/other split mirrors the one the HTTP layer already
      // makes (readVirtualFile / raw.ts): only a positively-absent path
      // gets the "not found" JSON-RPC code, everything else is a generic
      // internal error.
      if (error instanceof CoMotionNotFoundError) {
        throw new acp.RequestError(READ_NOT_FOUND_CODE, error.message);
      }
      if (error instanceof CoMotionError) {
        throw new acp.RequestError(READ_FAILED_CODE, error.message);
      }
      throw error;
    }
    return { content: applyLineWindow(content, params.line, params.limit) };
  }

  /**
   * Translates whatever `fs/read_text_file` sent as `path` into a virtual
   * path (fix 3). A relative path already *is* a virtual path — passed
   * through unchanged, exactly as before this fix, since that is both what
   * the brief itself names and what the existing tests exercise.
   *
   * An absolute path is translated by stripping the session cwd's
   * *resolved* prefix (`sessionCwdReal`) — resolved because a conforming
   * agent resolves the cwd's symlinks before it ever echoes a path back
   * (the `/var` vs `/private/var` case on macOS; see `sessionCwdReal`'s own
   * comment). `path.resolve` only normalizes the string itself (collapsing
   * `.`/`..` segments) — it never touches the real filesystem, because the
   * file this path names is virtual and need not exist on disk at all.
   *
   * Returns undefined when the absolute path does not fall under the
   * session cwd — the caller refuses outright rather than falling back to
   * any real-filesystem lookup; the cwd prefix is a translation rule, not
   * a containment mechanism, so there is no "resolve it anyway and see" to
   * fall back to.
   */
  private toVirtualPath(rawPath: string): string | undefined {
    if (!path.isAbsolute(rawPath)) return rawPath;
    if (this.sessionCwdReal === undefined) return undefined;
    const normalized = path.resolve(rawPath);
    const relative = path.relative(this.sessionCwdReal, normalized);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    return relative;
  }

  /** Attaches one SSE stream to this session's events; returns a detach function. */
  attachStream(send: (event: keyof ChatEvents, data: unknown) => void): () => void {
    const onChunk: ChatEvents["chat-chunk"] = (payload) => send("chat-chunk", payload);
    const onDone: ChatEvents["chat-done"] = (payload) => send("chat-done", payload);
    const onError: ChatEvents["chat-error"] = (payload) => send("chat-error", payload);
    const onCommand: ChatEvents["chat-command"] = (payload) => send("chat-command", payload);
    const onCommandUpdate: ChatEvents["chat-command-update"] = (payload) => send("chat-command-update", payload);
    this.on("chat-chunk", onChunk);
    this.on("chat-done", onDone);
    this.on("chat-error", onError);
    this.on("chat-command", onCommand);
    this.on("chat-command-update", onCommandUpdate);
    return () => {
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

/** Shared by `decidePermission` and the T5 freeze gate: would this request's command pass the allowlist? */
function isAllowedCommand(params: acp.RequestPermissionRequest): boolean {
  const command = extractCommand(params.toolCall);
  return command !== undefined && isCoMotionCommand(command);
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
function extractCommandOutput(content: acp.ToolCallContent[] | null | undefined): string | undefined {
  if (!content) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "content" && block.content.type === "text") {
      texts.push(block.content.text);
    }
  }
  if (texts.length === 0) return undefined;
  const joined = texts.join("\n");
  if (joined.length <= MAX_COMMAND_OUTPUT_CHARS) return joined;
  return joined.slice(0, MAX_COMMAND_OUTPUT_CHARS) + COMMAND_OUTPUT_TRUNCATED_SUFFIX;
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
  if (error instanceof CoMotionError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
