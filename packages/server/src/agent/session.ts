import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as acp from "@zed-industries/agent-client-protocol";
import { CoMotionError } from "@co-motion/core";
import type { AgentKind } from "./adapters.js";
import { EDITORIAL_BRIEF } from "./brief.js";

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
  private readyPromise: Promise<void> | undefined;
  /** Serializes turns so two `sendMessage` calls never interleave on one session. */
  private turnQueue: Promise<void> = Promise.resolve();
  /** True only while relaying updates for a turn the author actually asked for — not for the 編輯規約 turn. */
  private relayingCurrentTurn = false;
  private disposed = false;

  constructor(config: AgentAdapterConfig) {
    super();
    this.config = config;
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
      const response = await this.connection!.prompt({
        sessionId: this.sessionId!,
        prompt: [{ type: "text", text }],
      });
      this.emitTyped("chat-done", { stopReason: response.stopReason });
    } catch (error) {
      this.emitTyped("chat-error", { message: describeError(error) });
    } finally {
      this.relayingCurrentTurn = false;
    }
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
        // original child unreachable, even to dispose()).
        await this.teardownFailedSession();
        this.readyPromise = undefined;
        throw error;
      });
    }
    return this.readyPromise;
  }

  /** Tears down everything a failed `establishSession()` attempt may have left running. */
  private async teardownFailedSession(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
    this.connection = undefined;
    this.sessionId = undefined;
    if (this.sessionCwd) {
      await rm(this.sessionCwd, { recursive: true, force: true }).catch(() => {});
      this.sessionCwd = undefined;
    }
  }

  private async establishSession(): Promise<void> {
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
      env: this.config.env ? { ...process.env, ...this.config.env } : process.env,
    });
    this.child = child;
    child.once("error", (error) => {
      this.emitTyped("chat-error", { message: `啟動 ${this.config.label} 失敗：${error.message}` });
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection((_agent) => this.buildClient(), stream);
    this.connection = connection;

    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      // This unit grants no file access at all (ticket #6): declaring the
      // capability as false up front tells the agent so structurally,
      // rather than letting it discover the refusal by trying.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
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
      prompt: [{ type: "text", text: EDITORIAL_BRIEF }],
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
      requestPermission: async () => {
        // No allowlist here — ADR-0004's `co-motion *` allowlist is ticket
        // #7's job. This unit grants no access at all, so every permission
        // request is refused outright.
        return { outcome: { outcome: "cancelled" } };
      },
      // readTextFile / writeTextFile deliberately left unimplemented: the
      // agent was told via clientCapabilities that neither is available.
    };
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
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    if (this.sessionCwd) {
      await rm(this.sessionCwd, { recursive: true, force: true }).catch(() => {});
      this.sessionCwd = undefined;
    }
  }
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
