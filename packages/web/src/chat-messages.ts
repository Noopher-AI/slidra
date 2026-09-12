/**
 * Pure message-list operations for the chat sidebar (ticket #6, fix 3).
 *
 * Kept separate from App.tsx so the identity fix — a `chat-chunk` updates
 * the specific agent message it belongs to, never "whatever is last" —
 * is testable without rendering React.
 */

/** Something someone said: the author's own message, or the agent's reply text. */
export interface SpeechMessage {
  /** Stable identity, assigned once at creation. Never recomputed from position. */
  id: number;
  role: "author" | "agent";
  text: string;
}

/** ACP's own tool-call status, passed through verbatim — the UI translates it, the data does not. */
export type CommandStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * A command the agent ran (ticket #17). Deliberately not a `SpeechMessage`
 * with a role of "command": a command is not something anybody said, and
 * squeezing it into `text` would mean re-rendering its status by rewriting
 * a string, and re-deriving the command from that string later. It carries
 * its own fields instead, and its own ACP-assigned identity (`toolCallId`)
 * — which is what later status updates address it by, since a
 * `tool_call_update` names only the tool call, never a position in this
 * list.
 */
export interface CommandMessage {
  /** Same id space as SpeechMessage: this is the list's ordering/React key. */
  id: number;
  role: "command";
  /** ACP's `toolCallId` — the identity every later update addresses. */
  toolCallId: string;
  /** Verbatim from ACP's `rawInput.command`. Never reassembled here. */
  command: string;
  status: CommandStatus;
  /**
   * True for a `comotion` invocation. Only those carry a status the author
   * is meant to read: 執行中／完成／失敗 is a claim about the presentation,
   * and the agent's own shell work (reading its references, grepping) has
   * no outcome the author is being asked to act on. The command is still
   * shown — just without a tag, and never updated.
   */
  cli: boolean;
  /** Present only when the command failed — its own output, shown to the author as-is. */
  output?: string;
  /**
   * The stream died before this command's outcome arrived (ticket #19).
   * Deliberately a separate field rather than another `CommandStatus`
   * value: `status` is ACP's own vocabulary, passed through verbatim from
   * the agent, and when the connection drops we do not know whether the
   * command succeeded or failed. Writing "failed" here would be inventing
   * a result. This says only what we actually know — that we stopped
   * hearing — and leaves `status` at the last thing ACP really told us.
   */
  interrupted?: true;
  /**
   * The command never ran: CoMotion's own allowlist refused it (server:
   * `BLOCKED_COMMAND_MESSAGE`). A separate field rather than another
   * `CommandStatus` for the same reason as `interrupted` — `status` is
   * ACP's vocabulary, and ACP has no word for "the client refused this".
   * The distinction is worth drawing on screen: a failed command is the
   * agent's problem to fix, a blocked one is a rule the author should be
   * able to recognise as CoMotion's, not as something they clicked.
   */
  blocked?: true;
}

/**
 * Something that happened to the conversation itself, said by nobody
 * (ticket #19). It lives in the message list rather than in a banner
 * because *where* the stream broke is the whole point: it marks the turn
 * whose ending was lost, and stays put once later turns are appended
 * below it.
 */
export interface NoticeMessage {
  id: number;
  role: "notice";
  text: string;
}

/**
 * Something that happened to the conversation itself, said by nobody —
 * same shape as {@link NoticeMessage}, but a different fact ([E3.T5] §7
 * decision D3): a routine confirmation ("switched to agent X"), not a lost
 * turn. Kept as its own type rather than reusing `NoticeMessage` because
 * that type's rendering (`role="alert"`, assertive) is specifically for
 * "the stream broke, that turn's ending is gone" — an ordinary switch
 * confirmation must render `role="status"` instead, and merging the two
 * would make that distinction impossible to keep straight later.
 */
export interface SystemMessage {
  id: number;
  role: "system";
  text: string;
}

/**
 * Something that went wrong, said by nobody: the agent's turn failed, a
 * request the panel made (send, stop, switch model) did not go through.
 * A message rather than a banner for the same reason `NoticeMessage` is:
 * *when* it happened is the point — it stays put at the moment it
 * occurred while later turns are appended below it, instead of hanging at
 * the bottom looking current long after the fact.
 */
export interface ErrorMessage {
  id: number;
  role: "error";
  text: string;
}

export type ChatMessage = SpeechMessage | CommandMessage | NoticeMessage | SystemMessage | ErrorMessage;

/** Appends a brand-new message (author or agent) with the given id. */
export function appendMessage(
  messages: ChatMessage[],
  id: number,
  role: SpeechMessage["role"],
  text: string,
): ChatMessage[] {
  return [...messages, { id, role, text }];
}

/**
 * Appends `text` to the agent message identified by `id`. Addressed by
 * identity, not by array position — if the author sent a second message
 * after the reply started, that message is now the last item in the list,
 * but this still finds and updates only the agent's own message.
 */
export function appendChunkToMessage(messages: ChatMessage[], id: number, text: string): ChatMessage[] {
  return messages.map((message) =>
    message.id === id && message.role === "agent" ? { ...message, text: message.text + text } : message,
  );
}

/** Appends a notice about the conversation itself — a lost turn, not speech. */
export function appendNoticeMessage(messages: ChatMessage[], id: number, text: string): ChatMessage[] {
  return [...messages, { id, role: "notice", text }];
}

/** Appends an error at the moment it happened — a failed turn or a failed panel request. */
export function appendErrorMessage(messages: ChatMessage[], id: number, text: string): ChatMessage[] {
  return [...messages, { id, role: "error", text }];
}

/** Appends a system message — a routine fact about the conversation (e.g. an agent switch), not a lost turn. */
export function appendSystemMessage(messages: ChatMessage[], id: number, text: string): ChatMessage[] {
  return [...messages, { id, role: "system", text }];
}

/**
 * Flags every command whose outcome never arrived, because the stream
 * ended before it did. Selected by what ACP last said about them
 * (`pending`/`in_progress` are the non-final statuses), never by position
 * — the interrupted commands are not necessarily the last ones in the
 * list.
 */
export function markUnfinishedCommandsInterrupted(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.role === "command" && (message.status === "pending" || message.status === "in_progress")
      ? { ...message, interrupted: true as const }
      : message,
  );
}

/** Appends a command the agent has started running. */
export function appendCommandMessage(
  messages: ChatMessage[],
  id: number,
  toolCallId: string,
  command: string,
  status: CommandStatus,
  cli: boolean,
): ChatMessage[] {
  return [...messages, { id, role: "command", toolCallId, command, status, cli }];
}

/**
 * Patches the command message ACP identifies by `toolCallId`. Addressed by
 * identity for the same reason `appendChunkToMessage` is: by the time a
 * command finishes, the agent has usually said something else and the
 * command is no longer the last item.
 */
export function updateCommandMessage(
  messages: ChatMessage[],
  toolCallId: string,
  patch: { status: CommandStatus; output?: string; blocked?: true },
): ChatMessage[] {
  return messages.map((message) =>
    message.role === "command" && message.toolCallId === toolCallId ? { ...message, ...patch } : message,
  );
}
