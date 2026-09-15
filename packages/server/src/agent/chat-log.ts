// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { runJsonCommandWithStdin } from "../slidra/command.js";

/** Same union `AgentChatSession`'s `ChatEvents["chat-command"]` carries — restated here rather than imported to avoid a dependency from this module back onto `session.ts`. */
type CommandStatus = acp.ToolCallStatus;

/** One row `chat-history --append -` accepts — mirrors `crates/slidra/src/chat_history.rs`'s `ChatEntry` (minus `seq`, assigned by the deck itself). */
export interface ChatHistoryEntryInput {
  entryId: string;
  kind: "author" | "agent" | "command" | "divider";
  at: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface ChatLogOptions {
  /** Injected for tests; defaults to actually shelling out to `slidra chat-history <id> --append -`. */
  append?: (presentationId: string, entries: ChatHistoryEntryInput[]) => Promise<void>;
  /** Injected for tests — ISO 8601, same contract as `commands::comment`'s own clock. */
  now?: () => string;
  /** Injected for tests — `author`/`agent`/`divider` entries need a fresh id; `command` entries are keyed off `toolCallId` instead (see `recordCommand`). */
  nextEntryId?: () => string;
  /** How long a burst of chunk-sized writes (one per SSE `chat-chunk`) is coalesced into a single `--append -` call. Default 500ms. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;

async function defaultAppend(presentationId: string, entries: ChatHistoryEntryInput[]): Promise<void> {
  const result = await runJsonCommandWithStdin(["chat-history", presentationId, "--append", "-"], JSON.stringify(entries));
  if (!result.ok) {
    // Best-effort persistence: a failed flush must not take the live
    // conversation down (AC1/AC2 are about durability across a reload/
    // reopen, not a hard requirement that every write to the browser also
    // reaches disk). Logged so a systematic failure (e.g. a corrupted
    // deck) is at least visible in the server's own log.
    console.warn(`[chat-log] failed to persist ${entries.length} chat entr${entries.length === 1 ? "y" : "ies"}: ${result.message}`);
  }
}

/**
 * Persists the live conversation into the deck's own `chat_history` table,
 * batched and debounced so a fast-streaming reply does not shell out to the
 * `slidra` binary once per token. Lives at the `AgentManager` level (not
 * inside `AgentChatSession`): a session is disposed and rebuilt on every
 * agent switch, "New chat", and deck retarget, but the conversation it
 * belongs to must survive every one of those events — this class is what
 * survives them, one instance per open deck, `retarget()`'d rather than
 * rebuilt when the deck changes.
 *
 * Message segmentation mirrors `chat-stream.ts`'s `activeReplyId` rule
 * exactly (an agent's reply is one entry until a command interrupts it or
 * the turn ends, then a fresh entry starts) — anything else would make the
 * restored thread on reload look different from what streamed live.
 */
export class ChatLog {
  private presentationId: string;
  private readonly append: (presentationId: string, entries: ChatHistoryEntryInput[]) => Promise<void>;
  private readonly now: () => string;
  private readonly nextEntryId: () => string;
  private readonly debounceMs: number;

  /** Entries recorded since the last successful flush, keyed by `entryId` so repeated updates to the same row (chunk accumulation, a command's status update) coalesce into one row rather than queuing a write per event. Map preserves insertion order, which is what keeps a batch's relative order correct. */
  private pending = new Map<string, ChatHistoryEntryInput>();
  /** The last flushed version of each command row, keyed by `entryId`. The 500ms debounce timer starts on whichever event opens a batch, not on `recordCommand` itself, so a `chat-command-update` can easily arrive after its start row has already left `pending` — without this, `recordCommandUpdate` would upsert with `text: ""` and lose `meta.cli`, wiping the command's own text in the deck. Only `command` rows are tracked here; `author`/`agent`/`divider` entries never get a follow-up update keyed off the same `entryId`. */
  private lastFlushedCommands = new Map<string, ChatHistoryEntryInput>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Chains every flush so two overlapping `--append -` calls for the same deck can never race each other's writes. */
  private flushChain: Promise<void> = Promise.resolve();

  /** The agent entry currently accumulating chunks, or `null` between turns/after a command/divider closed it. */
  private openAgentEntry: { entryId: string; text: string; at: string } | null = null;

  constructor(presentationId: string, options: ChatLogOptions = {}) {
    this.presentationId = presentationId;
    this.append = options.append ?? defaultAppend;
    this.now = options.now ?? (() => new Date().toISOString());
    this.nextEntryId = options.nextEntryId ?? (() => `ce-${randomUUID()}`);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The author's own message — `displayText` (e.g. "(No message entered — sending N pinned comment(s) only)") wins over the raw `text` sent to the agent when both are given (§7 decision 8). */
  recordAuthor(text: string, displayText?: string): void {
    this.openAgentEntry = null;
    this.enqueue({ entryId: this.nextEntryId(), kind: "author", at: this.now(), text: displayText ?? text });
  }

  /** A `chat-chunk` — appended to the currently-open agent entry, or starts a new one (same rule `chat-stream.ts`'s `activeReplyId` uses). */
  recordAgentChunk(text: string): void {
    if (this.openAgentEntry) {
      this.openAgentEntry.text += text;
    } else {
      this.openAgentEntry = { entryId: this.nextEntryId(), text, at: this.now() };
    }
    this.enqueue({ entryId: this.openAgentEntry.entryId, kind: "agent", at: this.openAgentEntry.at, text: this.openAgentEntry.text });
  }

  /** A `chat-command` start — closes whatever agent entry was open (a command interrupts the sentence it began, same as the live UI) and records the command under an entry id derived from `toolCallId`, so `recordCommandUpdate` below upserts the very same row. */
  recordCommand(toolCallId: string, command: string, status: CommandStatus, cli: boolean): void {
    this.openAgentEntry = null;
    this.enqueue({
      entryId: commandEntryId(toolCallId),
      kind: "command",
      at: this.now(),
      text: command,
      meta: { toolCallId, status, cli },
    });
  }

  /** A `chat-command-update` — upserts the same row `recordCommand` created; the command text itself never changes, only its outcome. */
  recordCommandUpdate(toolCallId: string, patch: { status: CommandStatus; output?: string; blocked?: true }): void {
    const entryId = commandEntryId(toolCallId);
    const existing = this.pending.get(entryId) ?? this.lastFlushedCommands.get(entryId);
    const meta: Record<string, unknown> = { toolCallId, ...(existing?.meta ?? {}), ...patch };
    this.enqueue({
      entryId,
      kind: "command",
      at: existing?.at ?? this.now(),
      text: existing?.text ?? "",
      meta,
    });
  }

  /** An agent switch or "New chat" reset (§7 decisions 4/5) — closes whatever agent entry was open and records the server-built divider text as its own entry. */
  recordDivider(text: string): void {
    this.openAgentEntry = null;
    this.enqueue({ entryId: this.nextEntryId(), kind: "divider", at: this.now(), text });
  }

  /** The turn ended (`chat-done`/`chat-error`) — the next chunk, whenever it arrives, starts a fresh agent entry rather than continuing this one. */
  endTurn(): void {
    this.openAgentEntry = null;
  }

  /**
   * The session died (or was disposed) mid-turn — marks every command entry
   * still pending/in_progress in the *not-yet-flushed* batch as
   * interrupted, mirroring `chat-messages.ts`'s
   * `markUnfinishedCommandsInterrupted`. Entries already flushed to disk
   * keep whatever status they last had; a reload's own restore only ever
   * needs to reconcile what is still in memory at the moment of the drop.
   */
  markUnfinishedInterrupted(): void {
    this.openAgentEntry = null;
    for (const [entryId, entry] of this.pending) {
      if (entry.kind !== "command") continue;
      const status = entry.meta?.status;
      if (status !== "pending" && status !== "in_progress") continue;
      this.pending.set(entryId, { ...entry, meta: { ...entry.meta, interrupted: true } });
    }
  }

  /** Points this log at a different deck (`AgentManager.retarget`) — flushes whatever this deck still owed first, so switching decks never drops a write onto the wrong one. */
  async retarget(presentationId: string): Promise<void> {
    this.openAgentEntry = null;
    await this.flush();
    this.presentationId = presentationId;
  }

  private enqueue(entry: ChatHistoryEntryInput): void {
    this.pending.set(entry.entryId, entry);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  /** Forces an immediate flush of whatever is pending — used by `retarget()`/`dispose()`-time callers that must not lose the tail of a conversation to a still-pending debounce timer. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pending.size === 0) return this.flushChain;

    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const entry of batch) {
      if (entry.kind === "command") this.lastFlushedCommands.set(entry.entryId, entry);
    }
    const presentationId = this.presentationId;
    // Caught here, not left to propagate: `flushChain` must never become a
    // rejected promise — the next `enqueue()`'s timer chains onto it with
    // no `.catch` of its own, and a caller of `flush()` (`retarget()`,
    // `dispose()`) awaits it expecting "the attempt is over", not "throw
    // because the deck was mid-copy". A broken `append` is logged instead
    // (same best-effort contract `defaultAppend`'s own `ok:false` branch
    // already uses).
    this.flushChain = this.flushChain
      .then(() => this.append(presentationId, batch))
      .catch((error) => {
        console.warn(`[chat-log] flush failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.flushChain;
  }
}

function commandEntryId(toolCallId: string): string {
  return `cmd-${toolCallId}`;
}
