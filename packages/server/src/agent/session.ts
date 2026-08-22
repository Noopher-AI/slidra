import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as acp from "@zed-industries/agent-client-protocol";
import { CoMotionError, CoMotionNotFoundError, readPresentationFile } from "@co-motion/core";
import type { AgentKind } from "./adapters.js";
import { buildEditorialBrief } from "./brief.js";
import { isCoMotionCommand } from "./command-allowlist.js";

/**
 * `fs/write_text_file` is always refused (ADR-0004, first layer). The
 * message names the one command that exists for editing text today, so an
 * agent that tries to write directly can correct itself on the very next
 * turn (user story 32) instead of merely learning that it failed.
 */
const WRITE_REFUSED_MESSAGE =
  "CoMotion 不允許 agent 直接寫入檔案，這個方法一律會被拒絕。若要修改文字內容，請改執行 `co-motion text set` 命令。";

/**
 * Everything needed to spawn one ACP adapter subprocess. Real production
 * code builds this from a `selectAdapter()` result (command = the adapter
 * executable name, resolved via PATH). Tests build it by pointing `command`
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

/** Events an `AgentChatSession` emits while a user-triggered turn is active. */
interface ChatEvents {
  "chat-chunk": (payload: { text: string }) => void;
  "chat-done": (payload: { stopReason: string }) => void;
  "chat-error": (payload: { message: string }) => void;
}

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

  constructor(config: AgentAdapterConfig, presentationId: string) {
    super();
    this.config = config;
    this.presentationId = presentationId;
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

    this.relayingCurrentTurn = true;
    try {
      const response = await this.withInterrupt(
        this.connection!.prompt({
          sessionId: this.sessionId!,
          prompt: [{ type: "text", text }],
        }),
      );
      this.emitTyped("chat-done", { stopReason: response.stopReason });
    } catch (error) {
      this.emitTyped("chat-error", { message: describeError(error) });
    } finally {
      this.relayingCurrentTurn = false;
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
    await connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: buildEditorialBrief(this.presentationId) }],
    });
  }

  private buildClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        if (!this.relayingCurrentTurn) return;
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          this.emitTyped("chat-chunk", { text: update.content.text });
        }
        // Other update kinds (thoughts, tool calls, plans) carry no reply
        // text and this tracer-bullet unit has nothing to do with them yet.
      },
      requestPermission: async (params: acp.RequestPermissionRequest) => {
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
   * `session/request_permission` — the second layer of ADR-0004. Allows a
   * request only when the command it names is structurally guaranteed to
   * invoke the `co-motion` program and nothing else (see
   * `command-allowlist.ts`); refuses everything else, including any request
   * the command cannot be extracted from at all. The rule is hard-coded —
   * the author is never asked (user story 12).
   */
  private decidePermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    const command = extractCommand(params.toolCall);
    const allow = command !== undefined && isCoMotionCommand(command);
    const wantedKinds = allow ? (["allow_once", "allow_always"] as const) : (["reject_once", "reject_always"] as const);
    const option = params.options.find((candidate) => candidate.kind === wantedKinds[0]) ??
      params.options.find((candidate) => candidate.kind === wantedKinds[1]);
    if (!option) {
      // Cannot express the decision through any offered option — including
      // the case where we mean to allow but the agent offered no allow
      // option. Fail closed: `cancelled` grants nothing.
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
  attachStream(send: (event: "chat-chunk" | "chat-done" | "chat-error", data: unknown) => void): () => void {
    const onChunk: ChatEvents["chat-chunk"] = (payload) => send("chat-chunk", payload);
    const onDone: ChatEvents["chat-done"] = (payload) => send("chat-done", payload);
    const onError: ChatEvents["chat-error"] = (payload) => send("chat-error", payload);
    this.on("chat-chunk", onChunk);
    this.on("chat-done", onDone);
    this.on("chat-error", onError);
    return () => {
      this.off("chat-chunk", onChunk);
      this.off("chat-done", onDone);
      this.off("chat-error", onError);
    };
  }

  /** Kills the adapter subprocess. Called once from `serve`'s shutdown disposer. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.removeAllListeners();
    await this.teardownSession();
  }
}

/**
 * Pulls the shell command string a permission request is asking to run out
 * of `toolCall.rawInput`. ACP does not standardize this field's shape — it
 * is passed through verbatim from whatever tool the agent itself defined
 * (`rawInput` is untyped in the schema) — so this only recognizes the one
 * shape Claude Code's own Bash tool uses (`{ command: string, ... }`).
 * Anything else — a missing rawInput, a non-object, a non-string `command`
 * — returns undefined, which `decidePermission` treats as "cannot
 * determine the command" and refuses (fail closed).
 */
function extractCommand(toolCall: acp.ToolCallUpdate): string | undefined {
  const rawInput = toolCall.rawInput;
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const command = (rawInput as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
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
